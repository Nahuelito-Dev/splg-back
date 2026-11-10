import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import {
  ProcesoVigente,
  ProcessConfigService,
} from '../../distributor/process-config.service';
import { DeliveryService } from '../../delivery/delivery.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { CylinderService } from '../cylinder.service';
import { Cylinder, CylinderState } from '../entities/cylinder.entity';
import { TransitionCylinderDto } from '../dto/transition-cylinder.dto';
import {
  CylinderRecoveryCase,
  ESTADOS_A_RESOLVER,
  ESTADOS_VIVOS_DEL_RECUPERO,
  RecoveryCaseStatus,
} from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';
import { CylinderRecoveryMapper } from './cylinder-recovery.mapper';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { CylinderRecoveryAccountService } from './cylinder-recovery-account.service';
import { choferPuedeRetirar } from './domain/recovery-rules';
import {
  QueryRecoveryCasesDto,
  RecoveryDecision,
  ResolveRecoveryCaseDto,
} from './dto/recovery-request.dto';
import {
  DriverPickupDto,
  RecoveryCaseDetailDto,
  RecoveryCaseDto,
  RecoveryCasePageDto,
  RecoveryReportDto,
} from './dto/recovery-response.dto';

/** Pedidos en los que un retiro acordado todavía se puede cumplir o aceptar. */
const PEDIDO_QUE_ADMITE_RETIRO: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.RESERVED,
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
]);

const RELACIONES = { user: true, cylinder: { gasCylinder: true } } as const;

/**
 * Recuperación de envases (CU-108): lo que consultan y deciden las personas.
 * El administrador ve los casos y el legajo y decide (cobrar el depósito, dar
 * de baja el envase o cerrar sin cargo); el cliente responde la oferta de
 * retiro en su próxima entrega; el chofer confirma el retiro o dice por qué no
 * pudo. El motor que abre y hace avanzar los casos es `CylinderRecoveryService`.
 */
@Injectable()
export class CylinderRecoveryCasesService {
  constructor(
    @InjectRepository(CylinderRecoveryCase)
    private readonly cases: Repository<CylinderRecoveryCase>,
    @InjectRepository(CylinderRecoveryNotice)
    private readonly notices: Repository<CylinderRecoveryNotice>,
    private readonly engine: CylinderRecoveryService,
    private readonly cylinders: CylinderService,
    private readonly orders: OrderLookupService,
    private readonly deliveries: DeliveryService,
    private readonly processConfig: ProcessConfigService,
    private readonly cuenta: CylinderRecoveryAccountService,
  ) {}

  // ───────────────────────── administrador ─────────────────────────

  async listar(
    distributorId: string,
    q: QueryRecoveryCasesDto,
    ahora: Date = new Date(),
  ): Promise<RecoveryCasePageDto> {
    const where: FindOptionsWhere<CylinderRecoveryCase> = { distributorId };
    if (q.live) where.status = In([...ESTADOS_VIVOS_DEL_RECUPERO]);
    else if (q.pending) where.status = In([...ESTADOS_A_RESOLVER]);
    else if (q.status) where.status = q.status;
    if (q.step) where.step = q.step;
    if (q.customerId) where.userId = q.customerId;
    if (q.cylinderId) where.cylinderId = q.cylinderId;

    const [filas, total] = await this.cases.findAndCount({
      where,
      relations: RELACIONES,
      withDeleted: true,
      order: { openedAt: 'DESC' },
      take: q.limit ?? 10,
      skip: q.offset ?? 0,
    });
    return {
      data: await this.armar(filas, distributorId, ahora),
      total,
      counts: await this.contarPorEstado(distributorId),
    };
  }

  async detalle(
    caseId: string,
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<RecoveryCaseDetailDto> {
    const caso = await this.cases.findOne({
      where: { caseId, distributorId },
      relations: RELACIONES,
      withDeleted: true,
    });
    if (!caso) throw new NotFoundException('Caso de recupero no encontrado');
    const avisos = await this.avisosDe([caso.caseId]);
    const lista = avisos.get(caso.caseId) ?? [];
    const pedidos = await this.pedidosDe(lista, distributorId);
    const historial = await this.cylinders.getHistory(
      caso.cylinderId,
      distributorId,
    );
    const resolvio = caso.resolvedByUserId
      ? await this.cases.manager.getRepository(User).findOne({
          where: { userId: caso.resolvedByUserId },
          select: { userId: true, fullName: true },
          withDeleted: true,
        })
      : null;
    return CylinderRecoveryMapper.detalle(
      caso,
      lista,
      pedidos,
      historial,
      resolvio ? { fullName: resolvio.fullName ?? null } : null,
      ahora,
    );
  }

  /**
   * Paso 11: el administrador decide sobre un caso escalado o perdido. El
   * sistema registra la decisión, la nota y quién decidió; nunca cobra: el
   * cobro del depósito se hace aparte. Dar de baja el envase pasa por la
   * máquina de estados del envase y deja el movimiento en su historial.
   */
  async resolver(
    caseId: string,
    distributorId: string,
    dto: ResolveRecoveryCaseDto,
    actorUserId: string,
    ahora: Date = new Date(),
  ): Promise<RecoveryCaseDetailDto> {
    const cambio = await this.cases.manager.transaction(async (manager) => {
      const caso = await manager
        .createQueryBuilder(CylinderRecoveryCase, 'c')
        .setLock('pessimistic_write')
        .where('c.caseId = :caseId', { caseId })
        .andWhere('c.distributorId = :distributorId', { distributorId })
        .getOne();
      if (!caso) throw new NotFoundException('Caso de recupero no encontrado');
      if (!ESTADOS_A_RESOLVER.includes(caso.status)) {
        throw new ConflictException(
          caso.status === RecoveryCaseStatus.OPEN
            ? 'El caso sigue en su secuencia de avisos: se resuelve cuando se agota'
            : 'El caso ya está cerrado',
        );
      }
      // El envase se relee con lock antes de cualquier decisión: si ya volvió o
      // cambió de manos, el caso no corresponde y se cierra como corresponde.
      const envase = await manager
        .createQueryBuilder(Cylinder, 'e')
        .setLock('pessimistic_write')
        .where('e.cylinderId = :id', { id: caso.cylinderId })
        .andWhere('e.distributorId = :distributorId', { distributorId })
        .getOne();
      const sigueAfuera =
        envase?.state === CylinderState.WITH_CUSTOMER &&
        envase.currentCustomerId === caso.userId;
      if (!sigueAfuera) {
        return {
          retirado: envase?.state === CylinderState.RETIRED,
          cylinderId: caso.cylinderId,
        };
      }
      switch (dto.decision) {
        case RecoveryDecision.CHARGE_DEPOSIT:
          caso.status = RecoveryCaseStatus.DEPOSIT_CHARGED;
          // F35 E5: con «Cobrar envases» encendido el envase pasa a ser del cliente.
          await this.cuenta.compraPorDeposito(manager, {
            distributorId,
            customerUserId: caso.userId,
            gasCylinderId: envase.gasCylinderId,
            serial: envase.serial,
            actorUserId,
          });
          break;
        case RecoveryDecision.CLOSE_NO_CHARGE:
          caso.status = RecoveryCaseStatus.CLOSED_NO_CHARGE;
          break;
        case RecoveryDecision.WRITE_OFF:
          await this.cylinders.retireLost(
            caso.cylinderId,
            dto.note,
            distributorId,
            actorUserId,
            manager,
          );
          caso.status = RecoveryCaseStatus.WRITTEN_OFF;
          break;
      }
      caso.resolvedByUserId = actorUserId;
      caso.resolutionNote = dto.note;
      caso.closedAt = ahora;
      await manager.save(caso);
      return null;
    });
    if (cambio) {
      await this.engine.cerrarPorDevolucion(
        distributorId,
        cambio.cylinderId,
        ahora,
        cambio.retirado,
      );
      throw new ConflictException(
        'El envase ya volvió o cambió de manos: el caso se cerró y no hay nada que decidir',
      );
    }
    return this.detalle(caseId, distributorId, ahora);
  }

  /** Envases perdidos, escalados sin resolver y envases para revisión manual (excepciones 2, 10 y 11). */
  async reporte(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<RecoveryReportDto> {
    const filas = await this.cases.find({
      where: {
        distributorId,
        status: In([...ESTADOS_A_RESOLVER]),
      },
      relations: RELACIONES,
      withDeleted: true,
      order: { exhaustedAt: 'DESC' },
    });
    const todos = await this.armar(filas, distributorId, ahora);
    const lost = todos.filter((c) => c.status === RecoveryCaseStatus.LOST);
    const escalated = todos.filter(
      (c) => c.status === RecoveryCaseStatus.ESCALATED,
    );
    const params = await this.engine.parametros(distributorId);
    const { afuera } = await this.engine.envasesAReclamar(distributorId);
    const { revisionManual } = this.engine.clasificar(afuera, params, ahora);
    const suma = (cs: RecoveryCaseDto[]): number =>
      cs
        .reduce((acc, c) => acc.plus(c.depositAmount), new Decimal(0))
        .toNumber();
    return {
      lost,
      escalated,
      manualReview: revisionManual.map((r) => ({
        cylinderId: r.cylinderId,
        serial: r.serial,
        reason: r.motivo,
      })),
      totals: {
        lostCount: lost.length,
        lostAmount: suma(lost),
        escalatedCount: escalated.length,
        escalatedAmount: suma(escalated),
        manualReviewCount: revisionManual.length,
      },
    };
  }

  parametrosVigentes(distributorId: string): Promise<ProcesoVigente> {
    return this.processConfig.vigentes(
      distributorId,
      ConfigurableProcess.CYLINDER_RECOVERY,
    );
  }

  /** Cambia sólo los parámetros que vienen; los demás conservan su valor. */
  async cambiarParametros(
    distributorId: string,
    cambios: Record<string, number | undefined>,
    userId: string,
  ): Promise<ProcesoVigente> {
    // Dos cambios a la vez no se pisan: el segundo espera y lee lo que dejó el primero.
    return this.cases.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `recovery-settings:${distributorId}`,
      ]);
      const actuales = await this.processConfig.obtener(
        distributorId,
        ConfigurableProcess.CYLINDER_RECOVERY,
      );
      const nuevos: Record<string, number> = { ...actuales };
      for (const [clave, valor] of Object.entries(cambios)) {
        if (valor !== undefined) nuevos[clave] = valor;
      }
      return this.processConfig.guardar(
        distributorId,
        ConfigurableProcess.CYLINDER_RECOVERY,
        nuevos,
        userId,
      );
    });
  }

  // ───────────────────────── cliente ─────────────────────────

  /** Los casos del cliente que siguen en pie y le piden algo: abiertos y escalados. */
  async delCliente(
    customerId: string,
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<RecoveryCaseDto[]> {
    const filas = await this.cases.find({
      where: {
        distributorId,
        userId: customerId,
        status: In([RecoveryCaseStatus.OPEN, RecoveryCaseStatus.ESCALATED]),
      },
      relations: RELACIONES,
      withDeleted: true,
      order: { openedAt: 'ASC' },
    });
    return this.armar(filas, distributorId, ahora);
  }

  /**
   * Paso 8: el cliente acepta devolver el envase en su próxima entrega. El
   * retiro queda asociado al pedido de la oferta, que el chofer ve en su
   * recorrido; el caso espera la confirmación del retorno.
   */
  async aceptarRetiro(
    caseId: string,
    customerId: string,
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<RecoveryCaseDto> {
    return this.responderOferta(
      caseId,
      customerId,
      distributorId,
      ProposalStatus.ACCEPTED,
      ahora,
    );
  }

  /** El cliente prefiere devolverlo por su cuenta: la oferta se descarta y el caso sigue su escalón. */
  async rechazarRetiro(
    caseId: string,
    customerId: string,
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<RecoveryCaseDto> {
    return this.responderOferta(
      caseId,
      customerId,
      distributorId,
      ProposalStatus.REJECTED,
      ahora,
    );
  }

  private async responderOferta(
    caseId: string,
    customerId: string,
    distributorId: string,
    respuesta: ProposalStatus.ACCEPTED | ProposalStatus.REJECTED,
    ahora: Date,
  ): Promise<RecoveryCaseDto> {
    await this.cases.manager.transaction(async (manager) => {
      const caso = await manager
        .createQueryBuilder(CylinderRecoveryCase, 'c')
        .setLock('pessimistic_write')
        .where('c.caseId = :caseId', { caseId })
        .andWhere('c.userId = :customerId', { customerId })
        .andWhere('c.distributorId = :distributorId', { distributorId })
        .getOne();
      if (!caso) throw new NotFoundException('Caso de recupero no encontrado');
      if (caso.status !== RecoveryCaseStatus.OPEN) {
        throw new ConflictException('El caso ya no admite el retiro');
      }
      const oferta = await manager.findOne(CylinderRecoveryNotice, {
        where: {
          caseId,
          kind: RecoveryNoticeKind.PICKUP_OFFER,
          status: ProposalStatus.PENDING,
        },
      });
      if (!oferta) {
        throw new ConflictException('No hay una oferta de retiro vigente');
      }
      if (oferta.expiresAt.getTime() <= ahora.getTime()) {
        throw new ConflictException('La oferta de retiro venció');
      }
      if (respuesta === ProposalStatus.ACCEPTED) {
        const pedidos = await this.orders.findManyForRecovery(
          [oferta.orderId as string],
          distributorId,
        );
        const pedido = pedidos.get(oferta.orderId as string);
        if (
          !pedido ||
          pedido.customerId !== customerId ||
          !PEDIDO_QUE_ADMITE_RETIRO.has(pedido.status)
        ) {
          throw new ConflictException(
            'El pedido de la oferta ya no admite el retiro',
          );
        }
      }
      oferta.status = respuesta;
      oferta.respondedAt = ahora;
      await manager.save(oferta);
    });
    const caso = await this.cases.findOneOrFail({
      where: { caseId, distributorId },
      relations: RELACIONES,
      withDeleted: true,
    });
    const [dto] = await this.armar([caso], distributorId, ahora);
    return dto;
  }

  // ───────────────────────── chofer ─────────────────────────

  /** Los retiros acordados en pedidos que el chofer tiene asignados y todavía no terminó. */
  async retirosDelChofer(
    userId: string,
    distributorId: string,
  ): Promise<DriverPickupDto[]> {
    const chofer = await this.deliveries.buscarPorIdOUsuario(userId);
    if (!chofer) return [];
    const ofertas = await this.notices
      .createQueryBuilder('n')
      .innerJoin('n.recoveryCase', 'c')
      .where('n.kind = :kind', { kind: RecoveryNoticeKind.PICKUP_OFFER })
      .andWhere('n.status = :status', { status: ProposalStatus.ACCEPTED })
      .andWhere('c.status = :open', { open: RecoveryCaseStatus.OPEN })
      .andWhere('c.distributorId = :distributorId', { distributorId })
      .orderBy('n.sentAt', 'ASC')
      .getMany();
    if (ofertas.length === 0) return [];
    const pedidos = await this.orders.findManyForRecovery(
      ofertas.map((o) => o.orderId as string),
      distributorId,
    );
    const ahora = new Date();
    const propias = ofertas.filter((o) => {
      const p = pedidos.get(o.orderId as string);
      return (
        p?.deliveryId === chofer.deliveryId && choferPuedeRetirar(p, ahora)
      );
    });
    if (propias.length === 0) return [];
    const casos = await this.cases.find({
      where: { caseId: In(propias.map((o) => o.caseId)) },
      relations: RELACIONES,
      withDeleted: true,
    });
    const porCaso = new Map(casos.map((c) => [c.caseId, c]));
    return propias.flatMap((o) => {
      const caso = porCaso.get(o.caseId);
      const pedido = pedidos.get(o.orderId as string);
      if (!caso || !pedido) return [];
      return [
        {
          noticeId: o.noticeId,
          caseId: o.caseId,
          orderId: pedido.orderId,
          orderStatus: pedido.status,
          scheduledDate: pedido.scheduledDate,
          serial: caso.cylinder?.serial ?? '',
          product: caso.cylinder?.gasCylinder?.type ?? null,
          depositAmount: caso.depositAmount,
          customerName: caso.user?.fullName ?? null,
          customerPhone: caso.user?.phoneNumber ?? null,
        },
      ];
    });
  }

  /**
   * Paso 9: el chofer retiró el envase en la entrega. Pasa por la máquina de
   * estados del envase (`with_customer` → `empty_returned`), que dispara el
   * cierre del caso y libera el depósito.
   */
  async confirmarRetiro(
    noticeId: string,
    userId: string,
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<{ caseId: string; status: RecoveryCaseStatus }> {
    const { oferta, caso, pedido } = await this.retiroDelChofer(
      noticeId,
      userId,
      distributorId,
      ahora,
    );
    const envase = await this.cylinders.findOne(caso.cylinderId, distributorId);
    if (envase.state === CylinderState.WITH_CUSTOMER) {
      const dto = Object.assign(new TransitionCylinderDto(), {
        toState: CylinderState.EMPTY_RETURNED,
        note: `Retiro en la entrega del pedido ${pedido.orderId} (recupero de envases)`,
      });
      await this.cylinders.transition(
        caso.cylinderId,
        dto,
        distributorId,
        userId,
      );
    }
    await this.engine.cerrarPorDevolucion(
      distributorId,
      caso.cylinderId,
      ahora,
    );
    const cerrado = await this.cases.findOneOrFail({
      where: { caseId: oferta.caseId },
    });
    return { caseId: cerrado.caseId, status: cerrado.status };
  }

  /** Excepción 8: el chofer no pudo retirar el envase; el caso vuelve a su escalón. */
  async retiroNoRealizado(
    noticeId: string,
    userId: string,
    distributorId: string,
    motivo: string,
    ahora: Date = new Date(),
  ): Promise<{ caseId: string; status: RecoveryCaseStatus }> {
    const { oferta, caso } = await this.retiroDelChofer(
      noticeId,
      userId,
      distributorId,
      ahora,
    );
    oferta.status = ProposalStatus.EXPIRED;
    oferta.responseNote = motivo;
    await this.notices.save(oferta);
    return { caseId: caso.caseId, status: caso.status };
  }

  /** La oferta aceptada, su caso abierto y su pedido, siempre que el pedido sea de este chofer. */
  private async retiroDelChofer(
    noticeId: string,
    userId: string,
    distributorId: string,
    ahora: Date,
  ) {
    const chofer = await this.deliveries.buscarPorIdOUsuario(userId);
    const oferta = await this.notices.findOne({
      where: { noticeId, kind: RecoveryNoticeKind.PICKUP_OFFER },
      relations: { recoveryCase: true },
    });
    const caso = oferta?.recoveryCase;
    if (!chofer || !oferta || !caso || caso.distributorId !== distributorId) {
      throw new NotFoundException('Retiro no encontrado');
    }
    const pedidos = await this.orders.findManyForRecovery(
      [oferta.orderId as string],
      distributorId,
    );
    const pedido = pedidos.get(oferta.orderId as string);
    if (!pedido || pedido.deliveryId !== chofer.deliveryId) {
      throw new NotFoundException('Retiro no encontrado');
    }
    if (oferta.status !== ProposalStatus.ACCEPTED) {
      throw new ConflictException('El cliente no aceptó este retiro');
    }
    if (caso.status !== RecoveryCaseStatus.OPEN) {
      throw new ConflictException('El caso ya está cerrado');
    }
    if (!choferPuedeRetirar(pedido, ahora)) {
      throw new ForbiddenException(
        'El retiro se confirma con el pedido aceptado, en camino o entregado hace menos de 24 horas',
      );
    }
    return { oferta, caso, pedido };
  }

  // ───────────────────────── comunes ─────────────────────────

  private async contarPorEstado(
    distributorId: string,
  ): Promise<Record<string, number>> {
    const filas = await this.cases
      .createQueryBuilder('c')
      .select('c.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where('c.distributorId = :distributorId', { distributorId })
      .groupBy('c.status')
      .getRawMany<{ status: string; n: string }>();
    return Object.fromEntries(filas.map((f) => [f.status, Number(f.n)]));
  }

  private async avisosDe(
    ids: string[],
  ): Promise<Map<string, CylinderRecoveryNotice[]>> {
    const mapa = new Map<string, CylinderRecoveryNotice[]>();
    if (ids.length === 0) return mapa;
    const avisos = await this.notices.find({
      where: { caseId: In(ids) },
      order: { sentAt: 'ASC' },
    });
    for (const a of avisos) {
      const lista = mapa.get(a.caseId) ?? [];
      lista.push(a);
      mapa.set(a.caseId, lista);
    }
    return mapa;
  }

  private pedidosDe(avisos: CylinderRecoveryNotice[], distributorId: string) {
    return this.orders.findManyForRecovery(
      avisos.flatMap((a) => (a.orderId ? [a.orderId] : [])),
      distributorId,
    );
  }

  private async armar(
    casos: CylinderRecoveryCase[],
    distributorId: string,
    ahora: Date,
  ): Promise<RecoveryCaseDto[]> {
    const avisos = await this.avisosDe(casos.map((c) => c.caseId));
    const pedidos = await this.pedidosDe(
      [...avisos.values()].flat(),
      distributorId,
    );
    return casos.map((c) =>
      CylinderRecoveryMapper.caso(
        c,
        avisos.get(c.caseId) ?? [],
        pedidos,
        ahora,
      ),
    );
  }
}
