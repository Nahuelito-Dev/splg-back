import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { rangoDeDiasArgentinos } from '../../common/utils/dias-argentina';
import { aCentavos, dec } from '../../common/utils/dinero';
import {
  CashDirection,
  CashReferenceType,
  CashSessionStatus,
  CashSystemCode,
} from '../domain/cash.enums';
import { arqueo } from '../domain/cash-rules';
import {
  CajaNoEncontradaError,
  MovimientoInvalidoError,
  SesionNoEncontradaError,
} from '../domain/errors/cash.errors';
import {
  CloseCashSessionDto,
  OpenCashSessionDto,
  QueryCashSessionDto,
} from '../dto/cash-session.dto';
import { CashBox } from '../entities/cash-box.entity';
import { CashMovement } from '../entities/cash-movement.entity';
import { CashSession } from '../entities/cash-session.entity';
import { CashCategoryService } from './cash-category.service';
import { CashLedgerService } from './cash-ledger.service';

export interface SesionConCaja {
  sesion: CashSession;
  cashBoxName: string;
}

/** Apertura y cierre con arqueo de las cajas que exigen sesión (CU-226, CU-227). */
@Injectable()
export class CashSessionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: CashLedgerService,
    private readonly categorias: CashCategoryService,
  ) {}

  /**
   * Abre la sesión. Si el efectivo con que se abre no coincide con el saldo del
   * libro, asienta un ajuste de apertura (entrada si sobra, salida si falta)
   * para que el saldo sea exactamente el monto inicial.
   */
  async abrir(
    cashBoxId: string,
    dto: OpenCashSessionDto,
    distributorId: string,
    userId: string,
  ): Promise<SesionConCaja> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          await this.ledger.bloquearCajas(manager, [cashBoxId], distributorId);
          const caja = await manager.findOneByOrFail(CashBox, { cashBoxId });
          if (!caja.requiresSession) {
            throw new MovimientoInvalidoError(
              'La caja no exige sesión: no se abre ni se cierra',
            );
          }
          if (!caja.isActive) {
            throw new ConflictException('La caja está desactivada');
          }
          const abierta = await manager.findOne(CashSession, {
            where: { cashBoxId, status: CashSessionStatus.OPEN },
          });
          if (abierta) {
            throw new ConflictException(
              'La caja ya tiene una sesión abierta: cerrala antes de abrir otra',
            );
          }
          const sesion = await manager.save(
            manager.create(CashSession, {
              distributorId,
              cashBoxId,
              status: CashSessionStatus.OPEN,
              openedByUserId: userId,
              openingAmount: aCentavos(dto.openingAmount),
            }),
          );
          const ajuste = dec(dto.openingAmount).minus(caja.balance);
          if (!ajuste.isZero()) {
            await this.asentarAjuste(manager, {
              distributorId,
              cashBoxId,
              sessionId: sesion.sessionId,
              userId,
              diferencia: ajuste,
              referenceType: CashReferenceType.SESSION_OPENING,
              descripcion: `Ajuste de apertura: el saldo del libro era ${dec(caja.balance).toFixed(2)} y se abrió con ${dec(dto.openingAmount).toFixed(2)}`,
            });
          }
          return { sesion, cashBoxName: caja.name };
        }),
      { context: 'CashSessionService.abrir' },
    );
  }

  /**
   * Cierra con arqueo: esperado = apertura + Σ entradas − Σ salidas de la
   * sesión (el ajuste de apertura no cuenta). Si lo contado difiere se asienta
   * un ajuste con la categoría de sistema (sobrante o faltante) para que el
   * saldo quede igual a lo contado.
   */
  async cerrar(
    sessionId: string,
    dto: CloseCashSessionDto,
    distributorId: string,
    userId: string,
  ): Promise<SesionConCaja> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const previa = await manager.findOne(CashSession, {
            where: { sessionId, distributorId },
          });
          if (!previa) throw new SesionNoEncontradaError(sessionId);
          await this.ledger.bloquearCajas(
            manager,
            [previa.cashBoxId],
            distributorId,
          );
          const sesion = await manager.findOneByOrFail(CashSession, {
            sessionId,
          });
          if (sesion.status !== CashSessionStatus.OPEN) {
            throw new ConflictException('La sesión ya está cerrada');
          }
          const caja = await manager.findOneByOrFail(CashBox, {
            cashBoxId: sesion.cashBoxId,
          });
          const { entradas, salidas } = await this.totales(manager, sessionId);
          const { esperado, diferencia } = arqueo(
            sesion.openingAmount,
            entradas,
            salidas,
            dto.countedAmount,
          );
          if (!diferencia.isZero()) {
            await this.asentarAjuste(manager, {
              distributorId,
              cashBoxId: sesion.cashBoxId,
              sessionId,
              userId,
              diferencia,
              referenceType: CashReferenceType.SESSION_CLOSING,
              descripcion: `Diferencia de arqueo: se esperaban ${esperado.toFixed(2)} y se contaron ${dec(dto.countedAmount).toFixed(2)}`,
            });
          }
          sesion.status = CashSessionStatus.CLOSED;
          sesion.closedAt = new Date();
          sesion.closedByUserId = userId;
          sesion.expectedAmount = aCentavos(esperado);
          sesion.countedAmount = aCentavos(dto.countedAmount);
          sesion.difference = aCentavos(diferencia);
          sesion.notes = dto.notes ?? null;
          await manager.save(sesion);
          return { sesion, cashBoxName: caja.name };
        }),
      { context: 'CashSessionService.cerrar' },
    );
  }

  async findOne(
    sessionId: string,
    distributorId: string,
  ): Promise<SesionConCaja> {
    const sesion = await this.dataSource.manager.findOne(CashSession, {
      where: { sessionId, distributorId },
      relations: { cashBox: true },
    });
    if (!sesion) throw new SesionNoEncontradaError(sessionId);
    return { sesion, cashBoxName: sesion.cashBox?.name ?? '' };
  }

  /** Movimientos de la sesión, del más viejo al más nuevo. */
  movimientosDe(sessionId: string): Promise<CashMovement[]> {
    return this.dataSource.manager.find(CashMovement, {
      where: { sessionId },
      order: { occurredAt: 'ASC', createdAt: 'ASC' },
    });
  }

  async findByBox(
    cashBoxId: string,
    distributorId: string,
    query: QueryCashSessionDto,
  ): Promise<{ data: SesionConCaja[]; total: number }> {
    const caja = await this.dataSource.manager.findOne(CashBox, {
      where: { cashBoxId, distributorId },
    });
    if (!caja) throw new CajaNoEncontradaError(cashBoxId);
    const qb = this.dataSource.manager
      .createQueryBuilder(CashSession, 's')
      .where('s.cashBoxId = :cashBoxId', { cashBoxId });
    if (query.from || query.to) {
      const rango = rangoDeDiasArgentinos(
        query.from ?? query.to ?? '',
        query.to ?? query.from ?? '',
      );
      if (!rango) {
        throw new MovimientoInvalidoError('El período no es válido');
      }
      if (query.from)
        qb.andWhere('s.openedAt >= :desde', { desde: rango.desde });
      if (query.to) qb.andWhere('s.openedAt < :hasta', { hasta: rango.hasta });
    }
    const limit = query.limit ?? 10;
    const [sesiones, total] = await qb
      .orderBy('s.openedAt', 'DESC')
      .skip(((query.page ?? 1) - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      data: sesiones.map((sesion) => ({ sesion, cashBoxName: caja.name })),
      total,
    };
  }

  /** Σ entradas y salidas de la sesión, sin contar el ajuste de apertura. */
  private async totales(
    manager: EntityManager,
    sessionId: string,
  ): Promise<{ entradas: Decimal; salidas: Decimal }> {
    const filas: Array<{ direction: CashDirection; total: string }> =
      await manager.query(
        `SELECT "direction", COALESCE(SUM("amount"), 0)::text AS total
         FROM "cash_movement"
         WHERE "session_id" = $1 AND "reference_type" <> 'session_opening'
         GROUP BY "direction"`,
        [sessionId],
      );
    const de = (d: CashDirection) =>
      dec(filas.find((f) => f.direction === d)?.total);
    return { entradas: de(CashDirection.IN), salidas: de(CashDirection.OUT) };
  }

  /** Sobrante: entrada; faltante: salida. Por el punto único del libro. */
  private async asentarAjuste(
    manager: EntityManager,
    a: {
      distributorId: string;
      cashBoxId: string;
      sessionId: string;
      userId: string;
      diferencia: Decimal;
      referenceType: CashReferenceType;
      descripcion: string;
    },
  ): Promise<void> {
    const sobrante = a.diferencia.gt(0);
    const categoria = await this.categorias.deSistema(
      manager,
      a.distributorId,
      sobrante ? CashSystemCode.CASH_SURPLUS : CashSystemCode.CASH_SHORTAGE,
    );
    await this.ledger.registrar(manager, {
      distributorId: a.distributorId,
      cashBoxId: a.cashBoxId,
      direction: sobrante ? CashDirection.IN : CashDirection.OUT,
      amount: a.diferencia.abs(),
      categoryId: categoria.categoryId,
      description: a.descripcion,
      referenceType: a.referenceType,
      referenceId: a.sessionId,
      userId: a.userId,
      sessionId: a.sessionId,
    });
  }
}
