import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { rangoDeDiasArgentinos } from '../../common/utils/dias-argentina';
import { aCentavos, dec } from '../../common/utils/dinero';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  CashDirection,
  CashReferenceType,
  CashSystemCode,
} from '../domain/cash.enums';
import { motivoDeNoAnulable, sentidoOpuesto } from '../domain/cash-rules';
import {
  CajaNoEncontradaError,
  MovimientoInvalidoError,
  MovimientoNoEncontradoError,
} from '../domain/errors/cash.errors';
import {
  CreateCashMovementDto,
  QueryCashMovementDto,
  TransferCashDto,
} from '../dto/cash-movement.dto';
import { CashBox } from '../entities/cash-box.entity';
import { CashCategory } from '../entities/cash-category.entity';
import { CashMovement } from '../entities/cash-movement.entity';
import { CUENTA_PARA_EL_RESULTADO } from './income-statement-rules';
import { CashCategoryService } from './cash-category.service';
import { CashLedgerService } from './cash-ledger.service';

export interface MovimientoConNombres {
  movimiento: CashMovement;
  cashBoxName: string;
  categoryName: string;
  reversed: boolean;
  /** El pedido del que nace el movimiento, si es un cobro de venta. */
  orderId?: string | null;
}

/** Operaciones sobre el libro de movimientos (CU-228, 229, 309, 310, 340). */
@Injectable()
export class CashMovementService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: CashLedgerService,
    private readonly categorias: CashCategoryService,
  ) {}

  /** Entrada (CU-228) o salida (CU-309) manual. */
  async registrar(
    dto: CreateCashMovementDto,
    distributorId: string,
    userId: string,
  ): Promise<MovimientoConNombres> {
    const movimiento = await withTransactionRetry(
      () =>
        this.dataSource.transaction((manager) =>
          this.ledger.registrar(manager, {
            distributorId,
            cashBoxId: dto.cashBoxId,
            direction: dto.direction,
            amount: dto.amount,
            categoryId: dto.categoryId,
            method: dto.method,
            description: dto.description,
            referenceType: CashReferenceType.MANUAL,
            userId,
          }),
        ),
      { context: 'CashMovementService.registrar' },
    );
    return (await this.conNombres([movimiento]))[0];
  }

  /**
   * Transferencia entre cajas (CU-310): salida en el origen y entrada en el
   * destino por el mismo monto, en UNA transacción (o los dos o ninguno).
   */
  async transferir(
    dto: TransferCashDto,
    distributorId: string,
    userId: string,
  ): Promise<{ out: MovimientoConNombres; in: MovimientoConNombres }> {
    if (dto.fromCashBoxId === dto.toCashBoxId) {
      throw new MovimientoInvalidoError(
        'La caja de origen y la de destino tienen que ser distintas',
      );
    }
    const [salida, entrada] = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          await this.ledger.bloquearCajas(
            manager,
            [dto.fromCashBoxId, dto.toCashBoxId],
            distributorId,
          );
          const [catSalida, catEntrada] = [
            await this.categorias.deSistema(
              manager,
              distributorId,
              CashSystemCode.TRANSFER_OUT,
            ),
            await this.categorias.deSistema(
              manager,
              distributorId,
              CashSystemCode.TRANSFER_IN,
            ),
          ];
          const [origen, destino] = [
            await manager.findOneByOrFail(CashBox, {
              cashBoxId: dto.fromCashBoxId,
            }),
            await manager.findOneByOrFail(CashBox, {
              cashBoxId: dto.toCashBoxId,
            }),
          ];
          const nota = dto.description ? `: ${dto.description}` : '';
          const out = await this.ledger.registrar(manager, {
            distributorId,
            cashBoxId: origen.cashBoxId,
            direction: CashDirection.OUT,
            amount: dto.amount,
            categoryId: catSalida.categoryId,
            description: `Transferencia a ${destino.name}${nota}`.slice(0, 255),
            referenceType: CashReferenceType.BOX_TRANSFER,
            userId,
          });
          const entrada = await this.ledger.registrar(manager, {
            distributorId,
            cashBoxId: destino.cashBoxId,
            direction: CashDirection.IN,
            amount: dto.amount,
            categoryId: catEntrada.categoryId,
            description: `Transferencia desde ${origen.name}${nota}`.slice(
              0,
              255,
            ),
            referenceType: CashReferenceType.BOX_TRANSFER,
            referenceId: out.movementId,
            userId,
          });
          return [out, entrada] as const;
        }),
      { context: 'CashMovementService.transferir' },
    );
    const [out, ent] = await this.conNombres([salida, entrada]);
    return { out, in: ent };
  }

  /**
   * Anula un movimiento MANUAL con su contraasiento (CU-229): mismo importe y
   * categoría, sentido opuesto. Un movimiento se anula una sola vez y una
   * anulación no se anula. Los que nacen de otro documento (transferencia,
   * rendición, cobro, liquidación, arqueo) se corrigen por su propio caso de uso.
   */
  async anular(
    movementId: string,
    reason: string,
    distributorId: string,
    userId: string,
  ): Promise<MovimientoConNombres> {
    const contraasiento = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const previo = await manager.findOne(CashMovement, {
            where: { movementId, distributorId },
          });
          if (!previo) throw new MovimientoNoEncontradoError(movementId);
          // La regla depende sólo del origen, que no cambia (el libro es de solo
          // agregar): se valida antes de tomar la caja.
          if (previo.reversesMovementId) {
            throw new ConflictException(
              'Es una anulación: no se anula. Si estuvo mal, registrá un movimiento nuevo',
            );
          }
          const motivo = motivoDeNoAnulable(previo.referenceType);
          if (motivo) throw new MovimientoInvalidoError(motivo);
          // La caja primero: serializa con cualquier otro movimiento y con
          // otra anulación del mismo.
          await this.ledger.bloquearCajas(
            manager,
            [previo.cashBoxId],
            distributorId,
          );
          const yaAnulado = await manager.exists(CashMovement, {
            where: { reversesMovementId: movementId },
          });
          if (yaAnulado) {
            throw new ConflictException('El movimiento ya fue anulado');
          }
          return this.contraasiento(
            manager,
            previo,
            reason,
            distributorId,
            userId,
          );
        }),
      { context: 'CashMovementService.anular' },
    );
    return (await this.conNombres([contraasiento]))[0];
  }

  /**
   * Anula una transferencia entera (CU-310): los contraasientos de sus dos
   * patas en UNA transacción, con las dos cajas bloqueadas en orden. Se puede
   * pedir por cualquiera de las dos patas. Si el destino ya gastó el dinero y
   * una caja de efectivo quedaría en negativo, no se anula nada (409).
   */
  async anularTransferencia(
    movementId: string,
    reason: string,
    distributorId: string,
    userId: string,
  ): Promise<{ out: MovimientoConNombres; in: MovimientoConNombres }> {
    const [revierteSalida, revierteEntrada] = await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const pata = await manager.findOne(CashMovement, {
            where: { movementId, distributorId },
          });
          if (!pata) throw new MovimientoNoEncontradoError(movementId);
          if (pata.reversesMovementId) {
            throw new ConflictException(
              'Es una anulación: no se anula. Si estuvo mal, registrá un movimiento nuevo',
            );
          }
          if (pata.referenceType !== CashReferenceType.BOX_TRANSFER) {
            throw new MovimientoInvalidoError(
              'El movimiento no es una transferencia entre cajas',
            );
          }
          const salidaId =
            pata.direction === CashDirection.OUT
              ? pata.movementId
              : (pata.referenceId ?? '');
          const salida = await manager.findOne(CashMovement, {
            where: { movementId: salidaId, distributorId },
          });
          const entrada = await manager.findOne(CashMovement, {
            where: {
              referenceId: salidaId,
              referenceType: CashReferenceType.BOX_TRANSFER,
              direction: CashDirection.IN,
              distributorId,
            },
          });
          if (!salida || !entrada) {
            throw new MovimientoNoEncontradoError(movementId);
          }
          await this.ledger.bloquearCajas(
            manager,
            [salida.cashBoxId, entrada.cashBoxId],
            distributorId,
          );
          const yaAnulada = await manager.exists(CashMovement, {
            where: [
              { reversesMovementId: salida.movementId },
              { reversesMovementId: entrada.movementId },
            ],
          });
          if (yaAnulada) {
            throw new ConflictException('La transferencia ya fue anulada');
          }
          // Primero se devuelve lo que entró en el destino (puede no alcanzar),
          // después se repone el origen.
          const revierteEntrada = await this.contraasiento(
            manager,
            entrada,
            reason,
            distributorId,
            userId,
          );
          const revierteSalida = await this.contraasiento(
            manager,
            salida,
            reason,
            distributorId,
            userId,
          );
          return [revierteSalida, revierteEntrada] as const;
        }),
      { context: 'CashMovementService.anularTransferencia' },
    );
    const [out, ent] = await this.conNombres([revierteSalida, revierteEntrada]);
    return { out, in: ent };
  }

  private contraasiento(
    manager: EntityManager,
    original: CashMovement,
    reason: string,
    distributorId: string,
    userId: string,
  ): Promise<CashMovement> {
    return this.ledger.registrar(manager, {
      distributorId,
      cashBoxId: original.cashBoxId,
      direction: sentidoOpuesto(original.direction),
      amount: original.amount,
      categoryId: original.categoryId,
      method: original.method,
      description: `Anulación: ${reason}`.slice(0, 255),
      referenceType: CashReferenceType.REVERSAL,
      referenceId: original.movementId,
      reversesMovementId: original.movementId,
      userId,
      esContraasiento: true,
    });
  }

  /** Consulta del libro (CU-340): por caja, período, sentido, categoría y origen. */
  async consultar(
    distributorId: string,
    query: QueryCashMovementDto & { countsForResult?: boolean },
  ): Promise<{ data: MovimientoConNombres[]; total: number }> {
    const qb = this.dataSource.manager
      .createQueryBuilder(CashMovement, 'm')
      .where('m.distributorId = :distributorId', { distributorId });
    if (query.cashBoxId) {
      const existe = await this.dataSource.manager.exists(CashBox, {
        where: { cashBoxId: query.cashBoxId, distributorId },
      });
      if (!existe) throw new CajaNoEncontradaError(query.cashBoxId);
      qb.andWhere('m.cashBoxId = :cashBoxId', { cashBoxId: query.cashBoxId });
    }
    if (query.categoryId) {
      qb.andWhere('m.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }
    if (query.direction) {
      qb.andWhere('m.direction = :direction', { direction: query.direction });
    }
    if (query.countsForResult) qb.andWhere(CUENTA_PARA_EL_RESULTADO);
    if (query.referenceType) {
      qb.andWhere('m.referenceType = :referenceType', {
        referenceType: query.referenceType,
      });
    }
    if (query.from || query.to) {
      const rango = rangoDeDiasArgentinos(
        query.from ?? query.to ?? '',
        query.to ?? query.from ?? '',
      );
      if (!rango) throw new MovimientoInvalidoError('El período no es válido');
      if (query.from)
        qb.andWhere('m.occurredAt >= :desde', { desde: rango.desde });
      if (query.to)
        qb.andWhere('m.occurredAt < :hasta', { hasta: rango.hasta });
      if (query.from && query.to && query.from > query.to) {
        throw new MovimientoInvalidoError(
          'La fecha inicial no puede ser posterior a la final',
        );
      }
    }
    const limit = query.limit ?? 20;
    const [movimientos, total] = await qb
      .orderBy('m.occurredAt', 'DESC')
      .addOrderBy('m.createdAt', 'DESC')
      .addOrderBy('m.movementId', 'ASC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data: await this.conNombres(movimientos), total };
  }

  /**
   * Entradas y salidas del día argentino (CU-245), sin contar las transferencias
   * entre cajas ni los movimientos anulados (que se netean con su anulación).
   */
  async totalesDelDia(
    distributorId: string,
    dia: string,
  ): Promise<{ income: number; expense: number; count: number }> {
    const rango = rangoDeDiasArgentinos(dia, dia);
    if (!rango) throw new MovimientoInvalidoError('La fecha no es válida');
    const [fila]: Array<{
      entradas: string;
      salidas: string;
      cantidad: number;
    }> = await this.dataSource.query(
      `SELECT COALESCE(SUM(m."amount") FILTER (WHERE m."direction" = 'in'), 0)::text AS entradas,
                COALESCE(SUM(m."amount") FILTER (WHERE m."direction" = 'out'), 0)::text AS salidas,
                COUNT(*)::int AS cantidad
         FROM "cash_movement" m
         WHERE m."distributor_id" = $1 AND m."occurred_at" >= $2 AND m."occurred_at" < $3
           AND m."reference_type" NOT IN ('box_transfer', 'reversal')
           AND NOT EXISTS (
             SELECT 1 FROM "cash_movement" r WHERE r."reverses_movement_id" = m."movement_id")`,
      [distributorId, rango.desde, rango.hasta],
    );
    return {
      income: aCentavos(dec(fila.entradas)),
      expense: aCentavos(dec(fila.salidas)),
      count: fila.cantidad,
    };
  }

  /** Agrega nombre de caja y de categoría y si el movimiento ya fue anulado. */
  async conNombres(
    movimientos: CashMovement[],
  ): Promise<MovimientoConNombres[]> {
    if (movimientos.length === 0) return [];
    const m = this.dataSource.manager;
    const cajas = await m.findBy(
      CashBox,
      [...new Set(movimientos.map((x) => x.cashBoxId))].map((cashBoxId) => ({
        cashBoxId,
      })),
    );
    const categorias = await m.findBy(
      CashCategory,
      [...new Set(movimientos.map((x) => x.categoryId))].map((categoryId) => ({
        categoryId,
      })),
    );
    const anulados: Array<{ reverses_movement_id: string }> = await m.query(
      `SELECT "reverses_movement_id" FROM "cash_movement"
       WHERE "reverses_movement_id" = ANY($1::uuid[])`,
      [movimientos.map((x) => x.movementId)],
    );
    const anuladosSet = new Set(anulados.map((a) => a.reverses_movement_id));
    const pedidos = await this.pedidosDeLosCobros(movimientos);
    return movimientos.map((movimiento) => ({
      movimiento,
      cashBoxName:
        cajas.find((c) => c.cashBoxId === movimiento.cashBoxId)?.name ?? '',
      categoryName:
        categorias.find((c) => c.categoryId === movimiento.categoryId)?.name ??
        '',
      reversed: anuladosSet.has(movimiento.movementId),
      orderId: pedidos.get(movimiento.movementId) ?? null,
    }));
  }

  /**
   * El pedido de cada movimiento que nace de un cobro de venta: el efectivo y la
   * transferencia lo llevan como referencia; el pago, su comisión y su devolución,
   * a través del pago o de la solicitud de devolución.
   */
  private async pedidosDeLosCobros(
    movimientos: CashMovement[],
  ): Promise<Map<string, string>> {
    const pedidos = new Map<string, string>();
    const ids = (...tipos: CashReferenceType[]) =>
      movimientos.filter(
        (m) => m.referenceId && tipos.includes(m.referenceType),
      );
    for (const m of ids(
      CashReferenceType.ORDER_PAYMENT,
      CashReferenceType.ORDER_TRANSFER,
    )) {
      pedidos.set(m.movementId, m.referenceId as string);
    }
    const pagos = ids(CashReferenceType.PAYMENT, CashReferenceType.PAYMENT_FEE);
    if (pagos.length > 0) {
      const filas: Array<{ payment_id: string; order_id: string }> =
        await this.dataSource.manager.query(
          `SELECT "payment_id", "order_id" FROM "payment" WHERE "payment_id" = ANY($1::uuid[])`,
          [pagos.map((m) => m.referenceId)],
        );
      for (const m of pagos) {
        const fila = filas.find((f) => f.payment_id === m.referenceId);
        if (fila) pedidos.set(m.movementId, fila.order_id);
      }
    }
    const devoluciones = ids(CashReferenceType.PAYMENT_REFUND);
    if (devoluciones.length > 0) {
      const filas: Array<{ refund_id: string; order_id: string }> =
        await this.dataSource.manager.query(
          `SELECT "refund_id", "order_id" FROM "payment_refund" WHERE "refund_id" = ANY($1::uuid[])`,
          [devoluciones.map((m) => m.referenceId)],
        );
      for (const m of devoluciones) {
        const fila = filas.find((f) => f.refund_id === m.referenceId);
        if (fila) pedidos.set(m.movementId, fila.order_id);
      }
    }
    return pedidos;
  }
}
