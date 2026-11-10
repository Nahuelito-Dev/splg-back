import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { auditContext } from '../../audit/data/audit-context';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { User } from '../../users/entities/user.entity';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { errorCode, errorMessage } from '../../common/errors/error-message';
import { diaArgentino, sumarDias } from '../../common/utils/dias-argentina';
import { Cylinder, CylinderState } from '../entities/cylinder.entity';
import {
  CylinderRecoveryCase,
  ESTADOS_VIVOS_DEL_RECUPERO,
  RecoveryCaseStatus,
} from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';
import {
  avisoDelEscalon,
  destinoAlAgotarse,
  ParametrosDeRecupero,
  parametrosDeRecupero,
  retiroSigueVigente,
  siguientePaso,
  superaLaTolerancia,
  vencimientoDeLaOferta,
  vencimientoDelEscalon,
} from './domain/recovery-rules';
import {
  AvisoParaElCliente,
  ContextoDelRecupero,
  CylinderRecoveryNotifier,
} from './cylinder-recovery.notifier';
import {
  CylinderRecoveryAccountService,
  EnvasesCubiertos,
  NOTA_CUBIERTO_POR_LA_CUENTA,
} from './cylinder-recovery-account.service';

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Un envase en poder de un cliente, con el dato de cuándo se lo entregaron. */
export interface EnvaseRetenido {
  cylinderId: string;
  serial: string;
  customerId: string | null;
  deposit: number;
  deliveredAt: Date | null;
}

/** Un envase «con cliente» del que no se puede saber desde cuándo ni de quién (CU-108, excepción 2). */
export interface EnvaseParaRevisionManual {
  cylinderId: string;
  serial: string;
  customerId: string | null;
  motivo: 'sin_cliente' | 'sin_entrega_registrada';
}

export interface ResultadoDeLaCorrida {
  abiertos: number;
  avisos: number;
  ofertas: number;
  escalados: number;
  perdidos: number;
  cerradosPorDevolucion: number;
  /** Casos cerrados sin cargo porque el envase quedó cubierto por los propios del cliente (F35 E5). */
  cerradosPorCuenta: number;
  revisionManual: number;
}

/** Lo que una pasada sobre un caso dejó hecho; los avisos salen después del commit. */
interface ResultadoDelCaso {
  avisos: Array<{ aviso: CylinderRecoveryNotice; ctx: ContextoDelRecupero }>;
  ofertas: number;
  estado: RecoveryCaseStatus;
  caso: CylinderRecoveryCase;
  ctx: ContextoDelRecupero | null;
}

/**
 * Recuperación de envases no devueltos (CU-108, módulo inteligente M5): el
 * motor. Detecta los envases que siguen en poder de un cliente pasada la
 * tolerancia, abre su caso y lo hace avanzar por los escalones (recordatorio,
 * aviso del depósito, oferta de retiro en la próxima entrega) hasta que el
 * envase vuelve o el caso queda a resolución del administrador. El sistema
 * nunca cobra ni da de baja por su cuenta.
 *
 * Es idempotente: un caso por envase (único en la base), un aviso por escalón
 * (único en la base) y una oferta por pedido, así que dos corridas seguidas
 * no duplican nada.
 */
@Injectable()
export class CylinderRecoveryService {
  private readonly logger = new Logger(CylinderRecoveryService.name);

  constructor(
    @InjectRepository(CylinderRecoveryCase)
    private readonly cases: Repository<CylinderRecoveryCase>,
    @InjectRepository(CylinderRecoveryNotice)
    private readonly notices: Repository<CylinderRecoveryNotice>,
    private readonly processConfig: ProcessConfigService,
    private readonly orders: OrderLookupService,
    private readonly notifier: CylinderRecoveryNotifier,
    private readonly cuenta: CylinderRecoveryAccountService,
  ) {}

  // ───────────────────────── parámetros ─────────────────────────

  async parametros(distributorId: string): Promise<ParametrosDeRecupero> {
    return parametrosDeRecupero(
      await this.processConfig.obtener(
        distributorId,
        ConfigurableProcess.CYLINDER_RECOVERY,
      ),
    );
  }

  /** Distribuidoras que tienen envases afuera o casos vivos: las que el cron recorre. */
  async distribuidorasConEnvasesAfuera(): Promise<string[]> {
    const filas: Array<{ id: string }> = await this.cases.manager.query(
      `SELECT DISTINCT x.id FROM (
         SELECT distributor_id AS id FROM cylinder WHERE state = 'with_customer'
         UNION
         SELECT distributor_id AS id FROM cylinder_recovery_case WHERE status IN ('open', 'escalated', 'lost')
       ) x
       JOIN distributor d ON d.distributor_id = x.id
       WHERE d."deletedAt" IS NULL AND d.status = 'active'`,
    );
    return filas.map((f) => f.id);
  }

  // ───────────────────────── detección (paso 2) ─────────────────────────

  /**
   * Los envases en poder de un cliente que todavía no tienen caso para esa
   * entrega. Un caso ya cerrado por el administrador (cobro o cierre sin cargo)
   * con el envase todavía afuera tampoco se reabre: la entrega es la misma.
   */
  async envasesAfuera(distributorId: string): Promise<EnvaseRetenido[]> {
    const filas: Array<{
      cylinderId: string;
      serial: string;
      customerId: string | null;
      deposit: string;
      deliveredAt: Date | null;
    }> = await this.cases.manager.query(
      `SELECT c.cylinder_id AS "cylinderId", c.serial, c.current_customer_id AS "customerId",
              c.deposit, d.delivered_at AS "deliveredAt"
         FROM cylinder c
         LEFT JOIN LATERAL (
           SELECT MAX(m."createdAt") AS delivered_at
             FROM cylinder_movement m
            WHERE m.cylinder_id = c.cylinder_id AND m.to_state = 'with_customer'
         ) d ON true
        WHERE c.distributor_id = $1
          AND c.state = 'with_customer'
          AND NOT EXISTS (
            SELECT 1 FROM cylinder_recovery_case k
             WHERE k.cylinder_id = c.cylinder_id
               AND (k.status IN ('open', 'escalated', 'lost')
                    OR (d.delivered_at IS NOT NULL
                        AND k.delivered_at >= d.delivered_at - interval '1 second'))
          )
        ORDER BY c.serial`,
      [distributorId],
    );
    return filas.map((f) => ({
      ...f,
      deposit: Number(f.deposit),
      deliveredAt: f.deliveredAt ? new Date(f.deliveredAt) : null,
    }));
  }

  /**
   * Los envases afuera que se pueden reclamar. Con «Cobrar envases» encendido
   * se excluyen los cubiertos por los propios del cliente (F35 E5); apagado,
   * son todos los de `envasesAfuera`.
   */
  async envasesAReclamar(distributorId: string): Promise<{
    afuera: EnvaseRetenido[];
    cubiertos: EnvasesCubiertos | null;
  }> {
    const cubiertos = await this.cuenta.cubiertos(distributorId);
    const afuera = await this.envasesAfuera(distributorId);
    return {
      afuera: cubiertos
        ? afuera.filter((e) => !cubiertos.has(e.cylinderId))
        : afuera,
      cubiertos,
    };
  }

  /** Separa los retenidos (con quién y desde cuándo) de los que quedan para revisión manual. */
  clasificar(
    afuera: EnvaseRetenido[],
    p: ParametrosDeRecupero,
    ahora: Date,
  ): {
    retenidos: Array<
      EnvaseRetenido & { customerId: string; deliveredAt: Date }
    >;
    revisionManual: EnvaseParaRevisionManual[];
  } {
    const retenidos: Array<
      EnvaseRetenido & { customerId: string; deliveredAt: Date }
    > = [];
    const revisionManual: EnvaseParaRevisionManual[] = [];
    for (const e of afuera) {
      if (!e.customerId) {
        revisionManual.push({ ...e, motivo: 'sin_cliente' });
      } else if (!e.deliveredAt) {
        revisionManual.push({ ...e, motivo: 'sin_entrega_registrada' });
      } else if (superaLaTolerancia(e.deliveredAt, ahora, p.toleranceDays)) {
        retenidos.push({
          ...e,
          customerId: e.customerId,
          deliveredAt: e.deliveredAt,
        });
      }
    }
    return { retenidos, revisionManual };
  }

  // ───────────────────────── la corrida ─────────────────────────

  /**
   * CU-108 completo para una distribuidora: detecta, abre los casos que faltan
   * y hace avanzar los abiertos. Un caso que falla no frena a los demás.
   */
  async ejecutar(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<ResultadoDeLaCorrida> {
    const p = await this.parametros(distributorId);
    if (!p.enabled) {
      throw new ConflictException(
        'El recupero de envases está apagado para esta distribuidora: encendelo en los parámetros',
      );
    }
    // Fuera de un request (el cron) no hay contexto: se fija el de la distribuidora para que
    // los triggers de auditoría asienten con ella lo que escribe el proceso (el aviso no
    // tiene columna propia de distribuidora).
    return auditContext.run({ userId: null, ip: null, distributorId }, () =>
      this.correr(distributorId, p, ahora),
    );
  }

  private async correr(
    distributorId: string,
    p: ParametrosDeRecupero,
    ahora: Date,
  ): Promise<ResultadoDeLaCorrida> {
    const resultado: ResultadoDeLaCorrida = {
      abiertos: 0,
      avisos: 0,
      ofertas: 0,
      escalados: 0,
      perdidos: 0,
      cerradosPorDevolucion: 0,
      cerradosPorCuenta: 0,
      revisionManual: 0,
    };

    const { afuera, cubiertos } = await this.envasesAReclamar(distributorId);
    if (cubiertos) {
      resultado.cerradosPorCuenta = await this.cerrarCubiertos(
        distributorId,
        cubiertos,
        ahora,
      );
    }
    const { retenidos, revisionManual } = this.clasificar(afuera, p, ahora);
    resultado.revisionManual = revisionManual.length;
    for (const r of revisionManual) {
      this.logger.warn(
        `Recupero ${distributorId}: el envase ${r.serial} queda para revisión manual (${r.motivo})`,
      );
    }
    for (const r of retenidos) {
      try {
        if (await this.abrirCaso(distributorId, r, ahora)) {
          resultado.abiertos += 1;
        }
      } catch (error) {
        this.logger.error(
          `Recupero ${distributorId}: no se pudo abrir el caso del envase ${r.serial}: ${errorMessage(error)}`,
        );
      }
    }

    // Los escalados y perdidos también se recorren: si el envase volvió se cierran solos.
    const vivos = await this.cases.find({
      where: { distributorId, status: In([...ESTADOS_VIVOS_DEL_RECUPERO]) },
      select: { caseId: true },
      order: { openedAt: 'ASC' },
    });
    const porCliente = new Map<string, AvisoParaElCliente[]>();
    for (const { caseId } of vivos) {
      try {
        const r = await this.procesarCaso(caseId, p, ahora);
        if (!r) continue;
        resultado.avisos += r.avisos.filter(
          (a) => a.aviso.kind !== RecoveryNoticeKind.PICKUP_OFFER,
        ).length;
        resultado.ofertas += r.ofertas;
        if (r.estado === RecoveryCaseStatus.ESCALATED) resultado.escalados += 1;
        if (r.estado === RecoveryCaseStatus.LOST) resultado.perdidos += 1;
        if (r.estado === RecoveryCaseStatus.RETURNED) {
          resultado.cerradosPorDevolucion += 1;
        }
        this.reunirAvisos(r, porCliente);
      } catch (error) {
        this.logger.error(
          `Recupero ${distributorId}: falló el caso ${caseId}: ${errorMessage(error)}`,
        );
      }
    }
    // Un cliente recibe a lo sumo un push por corrida, con todos sus envases.
    for (const [userId, avisos] of porCliente) {
      await this.notifier.alClienteAgrupado(userId, avisos);
    }
    return resultado;
  }

  /**
   * F35 E5: los casos vivos cuyo envase quedó cubierto por los propios del
   * cliente (por ejemplo, después de una compra) se cierran sin cargo, los más
   * nuevos primero, sin aviso al cliente. Devuelve cuántos cerró.
   */
  private async cerrarCubiertos(
    distributorId: string,
    cubiertos: EnvasesCubiertos,
    ahora: Date,
  ): Promise<number> {
    if (cubiertos.size === 0) return 0;
    const vivos = await this.cases.find({
      where: {
        distributorId,
        status: In([...ESTADOS_VIVOS_DEL_RECUPERO]),
        cylinderId: In([...cubiertos.keys()]),
      },
      select: { caseId: true, cylinderId: true, userId: true },
      order: { deliveredAt: 'DESC', openedAt: 'DESC' },
    });
    let cerrados = 0;
    for (const vivo of vivos) {
      // Un caso de otro cliente (el envase cambió de manos) lo cierra la pasada normal como devuelto.
      if (cubiertos.get(vivo.cylinderId) !== vivo.userId) continue;
      try {
        const cerro = await this.cases.manager.transaction(async (manager) => {
          const caso = await manager
            .createQueryBuilder(CylinderRecoveryCase, 'c')
            .setLock('pessimistic_write')
            .where('c.caseId = :caseId', { caseId: vivo.caseId })
            .andWhere('c.distributorId = :distributorId', { distributorId })
            .getOne();
          if (!caso || !ESTADOS_VIVOS_DEL_RECUPERO.includes(caso.status)) {
            return false;
          }
          // La foto de `cubiertos` es de antes: bajo lock (caso → envase → cuenta, el mismo orden que la
          // decisión y la devolución) se relee el envase y se recalcula la cobertura de ese cliente y tipo.
          const envase = await manager
            .createQueryBuilder(Cylinder, 'e')
            .setLock('pessimistic_write')
            .where('e.cylinderId = :id', { id: caso.cylinderId })
            .andWhere('e.distributorId = :distributorId', { distributorId })
            .getOne();
          if (
            envase?.state !== CylinderState.WITH_CUSTOMER ||
            envase.currentCustomerId !== caso.userId ||
            !envase.gasCylinderId
          ) {
            return false;
          }
          const sigue = await this.cuenta.sigueCubierto(manager, {
            distributorId,
            cylinderId: caso.cylinderId,
            customerUserId: caso.userId,
            gasCylinderId: envase.gasCylinderId,
          });
          if (!sigue) return false;
          await this.cerrar(
            manager,
            caso,
            RecoveryCaseStatus.CLOSED_NO_CHARGE,
            ahora,
            NOTA_CUBIERTO_POR_LA_CUENTA,
          );
          return true;
        });
        if (cerro) cerrados += 1;
      } catch (error) {
        this.logger.error(
          `Recupero ${distributorId}: no se pudo cerrar el caso cubierto ${vivo.caseId}: ${errorMessage(error)}`,
        );
      }
    }
    return cerrados;
  }

  /** Abre el caso del envase (paso 3); si ya hay uno vivo lo retoma y devuelve false. */
  private async abrirCaso(
    distributorId: string,
    r: EnvaseRetenido & { customerId: string; deliveredAt: Date },
    ahora: Date,
  ): Promise<boolean> {
    try {
      await this.cases.save(
        this.cases.create({
          distributorId,
          cylinderId: r.cylinderId,
          userId: r.customerId,
          deliveredAt: r.deliveredAt,
          depositAmount: r.deposit,
          step: 1,
          status: RecoveryCaseStatus.OPEN,
          stepDueAt: ahora,
        }),
      );
      return true;
    } catch (error) {
      // Otra corrida lo abrió primero: el índice único deja un caso vivo por envase.
      if (errorCode(error) === '23505') return false;
      throw error;
    }
  }

  // ───────────────────────── un caso (pasos 4 a 10) ─────────────────────────

  /**
   * Hace avanzar un caso abierto: relee el envase (paso 4), resuelve las ofertas
   * de retiro, manda el aviso del escalón si falta, sube de escalón cuando
   * venció el plazo, ofrece el retiro en una entrega programada y, agotados los
   * escalones, lo escala o lo da por perdido. Devuelve null si el caso ya no
   * está abierto.
   */
  async procesarCaso(
    caseId: string,
    p: ParametrosDeRecupero,
    ahora: Date,
  ): Promise<ResultadoDelCaso | null> {
    return this.cases.manager.transaction(async (manager) => {
      const caso = await manager
        .createQueryBuilder(CylinderRecoveryCase, 'c')
        .setLock('pessimistic_write')
        .where('c.caseId = :caseId', { caseId })
        .getOne();
      if (!caso || !ESTADOS_VIVOS_DEL_RECUPERO.includes(caso.status)) {
        return null;
      }

      const envase = await manager.getRepository(Cylinder).findOne({
        where: {
          cylinderId: caso.cylinderId,
          distributorId: caso.distributorId,
        },
      });
      const ctx: ContextoDelRecupero = {
        serial: envase?.serial ?? '',
        diasAfuera: Math.max(
          0,
          Math.floor(
            (ahora.getTime() - caso.deliveredAt.getTime()) / MS_POR_DIA,
          ),
        ),
      };
      const salida: ResultadoDelCaso = {
        avisos: [],
        ofertas: 0,
        estado: RecoveryCaseStatus.OPEN,
        caso,
        ctx,
      };

      // Paso 4: si el envase volvió mientras el caso corría, se cierra sin más gestión.
      const sigueAfuera =
        envase?.state === CylinderState.WITH_CUSTOMER &&
        envase.currentCustomerId === caso.userId;
      if (!sigueAfuera) {
        if (envase?.state === CylinderState.RETIRED) {
          await this.cerrar(
            manager,
            caso,
            RecoveryCaseStatus.CLOSED_NO_CHARGE,
            ahora,
            'El envase se dio de baja por otra vía mientras el caso estaba abierto',
          );
          salida.estado = RecoveryCaseStatus.CLOSED_NO_CHARGE;
        } else {
          await this.cerrar(manager, caso, RecoveryCaseStatus.RETURNED, ahora);
          salida.estado = RecoveryCaseStatus.RETURNED;
        }
        return salida;
      }

      // Un caso escalado o perdido sólo espera la decisión: no hay más gestión.
      if (caso.status !== RecoveryCaseStatus.OPEN) return null;

      const avisos = await manager.find(CylinderRecoveryNotice, {
        where: { caseId },
        order: { sentAt: 'ASC' },
      });
      const pausado = await this.resolverOfertas(manager, caso, avisos, ahora);
      if (pausado) return salida;

      // Pasos 5 y 7: el aviso del escalón; si venció el plazo, el escalón siguiente.
      const avisoEnviado = avisos.some(
        (a) =>
          a.kind !== RecoveryNoticeKind.PICKUP_OFFER && a.step === caso.step,
      );
      const paso = siguientePaso(caso, avisoEnviado, ahora);
      if (paso.accion === 'avisar' || paso.accion === 'subir') {
        caso.step = paso.step;
        caso.stepDueAt = vencimientoDelEscalon(ahora, p);
        await manager.save(caso);
        const aviso = await manager.save(
          manager.create(CylinderRecoveryNotice, {
            caseId,
            step: caso.step,
            kind: avisoDelEscalon(caso.step),
            status: null,
            expiresAt: caso.stepDueAt,
          }),
        );
        salida.avisos.push({ aviso, ctx });
      } else if (paso.accion === 'agotar') {
        // Paso 10: agotados los escalones, escala o queda como envase perdido.
        caso.step = 3;
        caso.exhaustedAt = ahora;
        caso.status = destinoAlAgotarse(
          caso.depositAmount,
          p.escalationAmountThreshold,
        );
        await manager.save(caso);
        salida.estado = caso.status;
        if (caso.status === RecoveryCaseStatus.ESCALATED) {
          const usuario = await manager.getRepository(User).findOne({
            where: { userId: caso.userId },
            select: { userId: true, fullName: true },
          });
          ctx.customerName = usuario?.fullName ?? null;
        }
        return salida;
      }

      // Paso 6: si hay una entrega programada en la ventana, se ofrece el retiro en ese viaje.
      const oferta = await this.ofrecerRetiro(manager, caso, avisos, p, ahora);
      if (oferta) {
        salida.ofertas += 1;
        salida.avisos.push({
          aviso: oferta.aviso,
          ctx: { ...ctx, entregaProgramada: oferta.scheduledDate },
        });
      }
      return salida;
    });
  }

  /**
   * Las ofertas de retiro del caso (pasos 6 y 8, excepción 8): la que nadie
   * contestó vence; la aceptada cuyo pedido terminó sin retirar el envase
   * también (el caso vuelve a su escalón y sigue). Devuelve true si hay un
   * retiro acordado en un pedido que todavía no salió o no terminó: el caso
   * espera la confirmación del retorno y no avanza.
   */
  private async resolverOfertas(
    manager: EntityManager,
    caso: CylinderRecoveryCase,
    avisos: CylinderRecoveryNotice[],
    ahora: Date,
  ): Promise<boolean> {
    const ofertas = avisos.filter(
      (a) =>
        a.kind === RecoveryNoticeKind.PICKUP_OFFER &&
        (a.status === ProposalStatus.PENDING ||
          a.status === ProposalStatus.ACCEPTED),
    );
    if (ofertas.length === 0) return false;
    const pedidos = await this.orders.findManyForRecovery(
      ofertas.map((o) => o.orderId as string),
      caso.distributorId,
    );
    let pausado = false;
    for (const oferta of ofertas) {
      const pedido = pedidos.get(oferta.orderId as string);
      const activo = retiroSigueVigente(pedido, ahora);
      if (oferta.status === ProposalStatus.PENDING) {
        if (oferta.expiresAt.getTime() <= ahora.getTime() || !activo) {
          oferta.status = ProposalStatus.EXPIRED;
          await manager.save(oferta);
        }
      } else if (activo) {
        pausado = true;
      } else {
        oferta.status = ProposalStatus.EXPIRED;
        oferta.responseNote =
          'El pedido terminó sin que el chofer retirara el envase';
        await manager.save(oferta);
      }
    }
    return pausado;
  }

  /** Ofrece el retiro en la próxima entrega programada que todavía no se ofreció (paso 6). */
  private async ofrecerRetiro(
    manager: EntityManager,
    caso: CylinderRecoveryCase,
    avisos: CylinderRecoveryNotice[],
    p: ParametrosDeRecupero,
    ahora: Date,
  ): Promise<{ aviso: CylinderRecoveryNotice; scheduledDate: string } | null> {
    const hayOfertaViva = avisos.some(
      (a) =>
        a.kind === RecoveryNoticeKind.PICKUP_OFFER &&
        (a.status === ProposalStatus.PENDING ||
          a.status === ProposalStatus.ACCEPTED),
    );
    if (hayOfertaViva) return null;
    const yaOfrecidos = new Set(
      avisos
        .filter((a) => a.kind === RecoveryNoticeKind.PICKUP_OFFER)
        .map((a) => a.orderId),
    );
    const hoy = diaArgentino(ahora);
    const entregas = await this.orders.entregasProgramadas(
      caso.userId,
      caso.distributorId,
      hoy,
      sumarDias(hoy, p.pickupWindowDays),
    );
    const entrega = entregas.find((e) => !yaOfrecidos.has(e.orderId));
    // Excepción 6: sin entrega programada el escalón de oferta se saltea.
    if (!entrega) return null;
    const aviso = await manager.save(
      manager.create(CylinderRecoveryNotice, {
        caseId: caso.caseId,
        step: caso.step,
        kind: RecoveryNoticeKind.PICKUP_OFFER,
        status: ProposalStatus.PENDING,
        orderId: entrega.orderId,
        expiresAt: vencimientoDeLaOferta(ahora, p),
      }),
    );
    return { aviso, scheduledDate: entrega.scheduledDate };
  }

  /** Cierra el caso con su estado final y la fecha (y la nota, si el cierre la lleva). */
  private async cerrar(
    manager: EntityManager,
    caso: CylinderRecoveryCase,
    estado: RecoveryCaseStatus,
    ahora: Date,
    nota: string | null = null,
  ): Promise<void> {
    caso.status = estado;
    caso.closedAt = ahora;
    caso.resolutionNote = nota;
    await manager.save(caso);
    // Una oferta que nadie contestó ya no tiene sentido con el caso cerrado.
    await manager
      .createQueryBuilder()
      .update(CylinderRecoveryNotice)
      .set({ status: ProposalStatus.EXPIRED })
      .where('case_id = :caseId', { caseId: caso.caseId })
      .andWhere(`kind = :kind`, { kind: RecoveryNoticeKind.PICKUP_OFFER })
      .andWhere('status = :status', { status: ProposalStatus.PENDING })
      .execute();
  }

  /**
   * Con el commit hecho: el socket de cada aviso sale ya (sin push) y el aviso
   * al administrador también; el push se junta por cliente y sale una sola vez
   * al terminar la corrida.
   */
  private reunirAvisos(
    r: ResultadoDelCaso,
    porCliente: Map<string, AvisoParaElCliente[]>,
  ): void {
    if (!r.ctx) return;
    for (const { aviso, ctx } of r.avisos) {
      this.notifier.porSocket(r.caso, aviso, ctx);
      const lista = porCliente.get(r.caso.userId) ?? [];
      lista.push({ caso: r.caso, aviso, ctx });
      porCliente.set(r.caso.userId, lista);
    }
    if (r.estado === RecoveryCaseStatus.ESCALATED) {
      this.notifier.escaladoAlAdmin(r.caso, r.ctx);
    }
  }

  // ───────────────────────── devolución (paso 9) ─────────────────────────

  /**
   * El envase volvió: cierra su caso vivo (abierto, escalado o perdido) como
   * devuelto y libera el depósito. Lo dispara el movimiento de retorno del
   * módulo de envases, sin esperar a la corrida. Idempotente: sin caso vivo no
   * hace nada. Devuelve true si cerró uno.
   */
  async cerrarPorDevolucion(
    distributorId: string,
    cylinderId: string,
    ahora: Date = new Date(),
    envaseDadoDeBaja = false,
  ): Promise<boolean> {
    return this.cases.manager.transaction(async (manager) => {
      const caso = await manager
        .createQueryBuilder(CylinderRecoveryCase, 'c')
        .setLock('pessimistic_write')
        .where('c.cylinderId = :cylinderId', { cylinderId })
        .andWhere('c.distributorId = :distributorId', { distributorId })
        .andWhere('c.status IN (:...vivos)', {
          vivos: ESTADOS_VIVOS_DEL_RECUPERO,
        })
        .getOne();
      if (!caso) return false;
      if (envaseDadoDeBaja) {
        await this.cerrar(
          manager,
          caso,
          RecoveryCaseStatus.CLOSED_NO_CHARGE,
          ahora,
          'El envase se dio de baja por otra vía mientras el caso estaba abierto',
        );
      } else {
        await this.cerrar(manager, caso, RecoveryCaseStatus.RETURNED, ahora);
      }
      return true;
    });
  }
}
