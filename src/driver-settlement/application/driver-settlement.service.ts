import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { CashCategoryService } from '../../cash/application/cash-category.service';
import { CashLedgerService } from '../../cash/application/cash-ledger.service';
import {
  CashDirection,
  CashReferenceType,
  CashSystemCode,
  CategoryDirection,
} from '../../cash/domain/cash.enums';
import { CashCategory } from '../../cash/entities/cash-category.entity';
import { CommissionLedgerService } from '../../commission/application/commission-ledger.service';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { bloquearChoferVigente } from '../../common/locks/chofer-lock';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { aCentavos, dec, sumar } from '../../common/utils/dinero';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  DocType,
  DocumentSequenceService,
} from '../../document-sequence/document-sequence.service';
import {
  diferenciaDeRendicion,
  exigirEstado,
  resolucionDeDiferencia,
} from '../domain/driver-settlement-rules';
import {
  DifferenceResolution,
  DriverSettlementStatus,
} from '../domain/driver-settlement.enums';
import {
  ChoferNoEncontradoError,
  RendicionConflictoError,
  RendicionInvalidaError,
  RendicionNoEncontradaError,
} from '../domain/errors/driver-settlement.errors';
import {
  ApproveDriverSettlementDto,
  SubmitDriverSettlementDto,
} from '../dto/driver-settlement.dto';
import { DriverSettlementCollection } from '../entities/driver-settlement-collection.entity';
import { DriverSettlementExpense } from '../entities/driver-settlement-expense.entity';
import { DriverSettlementOrder } from '../entities/driver-settlement-order.entity';
import { DriverSettlement } from '../entities/driver-settlement.entity';
import {
  choferesConPedidosSinRendir,
  pedidosSinRendir,
  sumaACobrar,
} from './settlement-orders';
import { DriverSettlementQueryService } from './driver-settlement-query.service';

const CARGA_CERRADA = ['closed', 'closed_with_difference', 'cancelled'];

/**
 * Rendición diaria del chofer (CU-231, 232, 233, 330): se abre por chofer y día,
 * el chofer declara el efectivo y los gastos, y el administrador la aprueba (el
 * efectivo entra a una caja por el libro) o la reabre.
 *
 * Orden de locks: chofer → carga del camión → rendición → caja → cuenta
 * corriente → numeración. La rendición bloquea su fila y recalcula lo esperado
 * bajo ese lock.
 */
@Injectable()
export class DriverSettlementService {
  private readonly logger = new Logger(DriverSettlementService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly secuencia: DocumentSequenceService,
    private readonly ledger: CashLedgerService,
    private readonly categorias: CashCategoryService,
    private readonly comisiones: CommissionLedgerService,
    private readonly consultas: DriverSettlementQueryService,
  ) {}

  /**
   * Abre la rendición del chofer para el día (CU-231). `estricto`: una que ya
   * existe es 409 (alta manual del administrador); si no, se devuelve la
   * existente (el chofer que la abre al pedirla, el proceso nocturno).
   */
  async abrir(
    distributorId: string,
    deliveryId: string,
    businessDate: string,
    estricto: boolean,
  ): Promise<DriverSettlement> {
    return withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const [chofer]: Array<{ delivery_id: string }> = await manager.query(
            `SELECT "delivery_id" FROM "delivery" WHERE "delivery_id" = $1 AND "distributor_id" = $2`,
            [deliveryId, distributorId],
          );
          if (!chofer || !(await bloquearChoferVigente(manager, deliveryId))) {
            throw new ChoferNoEncontradoError(deliveryId);
          }
          const existente = await manager.findOne(DriverSettlement, {
            where: { deliveryId, businessDate },
          });
          if (existente) {
            if (estricto) {
              throw new RendicionConflictoError(
                `El chofer ya tiene la rendición N° ${existente.number} de ese día`,
              );
            }
            return existente;
          }
          const [carga]: Array<{ load_id: string }> = await manager.query(
            `SELECT t."load_id" FROM "truck_load" t
             WHERE t."delivery_id" = $1 AND t."business_date" = $2 AND t."status" <> 'cancelled'
               AND NOT EXISTS (SELECT 1 FROM "driver_settlement" s WHERE s."truck_load_id" = t."load_id")
             ORDER BY t."opened_at" DESC LIMIT 1`,
            [deliveryId, businessDate],
          );
          const numero = await this.secuencia.siguienteNumero(
            manager,
            distributorId,
            DocType.DRIVER_SETTLEMENT,
          );
          const nueva = await manager.save(
            manager.create(DriverSettlement, {
              distributorId,
              deliveryId,
              number: numero,
              truckLoadId: carga?.load_id ?? null,
              businessDate,
              status: DriverSettlementStatus.OPEN,
              expectedCash: 0,
              driverExpenses: 0,
            }),
          );
          const vivo = await this.consultas.esperadoEnVivo(manager, nueva);
          nueva.expectedCash = aCentavos(vivo.expected);
          return manager.save(nueva);
        }),
      { context: 'DriverSettlementService.abrir' },
    );
  }

  /**
   * Proceso nocturno (CU-231): abre la rendición de cada chofer que entregó
   * pedidos en efectivo y todavía no los rindió. Devuelve cuántas abrió.
   */
  async generarDelDia(businessDate: string = diaArgentino()): Promise<number> {
    const candidatos = await choferesConPedidosSinRendir(
      this.dataSource.manager,
      businessDate,
    );
    let abiertas = 0;
    for (const c of candidatos) {
      try {
        await this.abrir(c.distributorId, c.deliveryId, businessDate, false);
        abiertas += 1;
      } catch (error) {
        this.logger.error(
          `No se pudo abrir la rendición del chofer ${c.deliveryId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return abiertas;
  }

  /**
   * El chofer (o el administrador por él) declara el efectivo y los gastos
   * (CU-232). Recalcula lo esperado bajo el lock de la rendición y toma sus
   * pedidos: de ahí en más ninguna otra rendición los cuenta.
   */
  async presentar(
    id: string,
    dto: SubmitDriverSettlementDto,
    distributorId: string,
    userId: string,
    soloDelUsuario?: string,
  ): Promise<void> {
    try {
      await withTransactionRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            const s = await this.bloquear(
              manager,
              id,
              distributorId,
              soloDelUsuario,
            );
            exigirEstado(s.status, 'submit');
            const gastos = dto.expenses ?? [];
            await this.validarCategoriasDeGasto(
              manager,
              distributorId,
              gastos.map((g) => g.categoryId),
            );
            const pedidos = await pedidosSinRendir(
              manager,
              {
                distributorId,
                deliveryId: s.deliveryId,
                businessDate: s.businessDate,
              },
              { bloquear: true },
            );
            for (const p of pedidos) {
              await manager.insert(DriverSettlementOrder, {
                settlementId: id,
                orderId: p.orderId,
                amount: p.amountToCollect,
                paymentMethod: 'cash',
              });
            }
            const [cobros]: Array<{ total: string }> = await manager.query(
              `SELECT COALESCE(SUM("amount"), 0)::text AS total
               FROM "driver_settlement_collection" WHERE "settlement_id" = $1`,
              [id],
            );
            const esperado = sumaACobrar(pedidos).plus(cobros.total);
            const totalGastos = sumar(gastos.map((g) => g.amount));
            for (const g of gastos) {
              await manager.insert(DriverSettlementExpense, {
                settlementId: id,
                categoryId: g.categoryId,
                amount: aCentavos(g.amount),
                description: g.description ?? null,
              });
            }
            s.expectedCash = aCentavos(esperado);
            s.declaredCash = aCentavos(dto.declaredCash);
            s.driverExpenses = aCentavos(totalGastos);
            s.difference = aCentavos(
              diferenciaDeRendicion(dto.declaredCash, totalGastos, esperado),
            );
            s.status = DriverSettlementStatus.SUBMITTED;
            s.submittedAt = new Date();
            s.submittedByUserId = userId;
            if (dto.notes) s.notes = dto.notes;
            await manager.save(s);
          }),
        { context: 'DriverSettlementService.presentar' },
      );
    } catch (error) {
      if (codigoSqlDelError(error) === '23505') {
        throw new RendicionConflictoError(
          'Alguno de los pedidos ya fue tomado por otra rendición: reabrí esa antes de presentar ésta',
        );
      }
      throw error;
    }
  }

  /**
   * Aprueba la rendición presentada (CU-233): el efectivo declarado entra a la
   * caja por el libro con la categoría "rendición de chofer" (incluye los
   * cobros de cuenta corriente de la calle) y, si el faltante queda a cargo del
   * chofer, se le descuenta en la próxima liquidación. Una aprobada no se reabre.
   */
  async aprobar(
    id: string,
    dto: ApproveDriverSettlementDto,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const s = await this.bloquear(manager, id, distributorId);
          exigirEstado(s.status, 'approve');
          const resolucion = resolucionDeDiferencia(
            s.difference ?? 0,
            dto.differenceResolution,
          );
          if (s.truckLoadId) {
            const [carga]: Array<{ status: string }> = await manager.query(
              `SELECT "status" FROM "truck_load" WHERE "load_id" = $1`,
              [s.truckLoadId],
            );
            if (carga && !CARGA_CERRADA.includes(carga.status)) {
              throw new RendicionConflictoError(
                'La carga del camión de este turno todavía no está cerrada: cerrala antes de aprobar la rendición',
              );
            }
          }
          // La caja se valida siempre (404), aunque no entre dinero.
          await this.ledger.bloquearCajas(
            manager,
            [dto.cashBoxId],
            distributorId,
          );
          let movimientoId: string | null = null;
          if (dec(s.declaredCash ?? 0).gt(0)) {
            const categoria = await this.categorias.deSistema(
              manager,
              distributorId,
              CashSystemCode.DRIVER_SETTLEMENT,
            );
            const movimiento = await this.ledger.registrar(manager, {
              distributorId,
              cashBoxId: dto.cashBoxId,
              direction: CashDirection.IN,
              amount: s.declaredCash ?? 0,
              categoryId: categoria.categoryId,
              description: `Rendición N° ${s.number} del ${s.businessDate}`,
              referenceType: CashReferenceType.DRIVER_SETTLEMENT,
              referenceId: s.settlementId,
              userId,
            });
            movimientoId = movimiento.movementId;
          }
          if (resolucion === DifferenceResolution.CHARGED_TO_DRIVER) {
            await this.comisiones.registrarFaltante(manager, {
              distributorId,
              deliveryId: s.deliveryId,
              faltante: dec(s.difference ?? 0).abs(),
              settlementId: s.settlementId,
              settlementNumber: s.number,
              userId,
            });
          }
          s.status = DriverSettlementStatus.APPROVED;
          s.destinationCashBoxId = dto.cashBoxId;
          s.cashMovementId = movimientoId;
          s.differenceResolution = resolucion;
          s.approvedAt = new Date();
          s.approvedByUserId = userId;
          if (dto.notes) s.notes = dto.notes;
          await manager.save(s);
        }),
      { context: 'DriverSettlementService.aprobar' },
    );
  }

  /**
   * Reabre una rendición presentada (CU-330) para que se declare de nuevo:
   * libera los pedidos que había tomado y borra los gastos declarados.
   */
  async reabrir(id: string, distributorId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const s = await this.bloquear(manager, id, distributorId);
      exigirEstado(s.status, 'reopen');
      await manager.delete(DriverSettlementOrder, { settlementId: id });
      await manager.delete(DriverSettlementExpense, { settlementId: id });
      s.status = DriverSettlementStatus.OPEN;
      s.declaredCash = null;
      s.driverExpenses = 0;
      s.difference = null;
      s.submittedAt = null;
      s.submittedByUserId = null;
      await manager.save(s);
    });
  }

  /**
   * Para el cobro de cuenta corriente en la calle (CU-237): la rendición abierta
   * del chofer, bloqueada. La más nueva si tiene varias. 409 si no tiene.
   */
  async bloquearAbiertaDelChofer(
    manager: EntityManager,
    distributorId: string,
    deliveryId: string,
  ): Promise<string> {
    // Sin LIMIT: con `LIMIT 1 FOR UPDATE`, si la fila cambia mientras se espera
    // el lock Postgres la descarta y devuelve vacío aunque haya otra abierta.
    const [fila]: Array<{ settlement_id: string }> = await manager.query(
      `SELECT "settlement_id" FROM "driver_settlement"
       WHERE "distributor_id" = $1 AND "delivery_id" = $2 AND "status" = 'open'
       ORDER BY "business_date" DESC
       FOR UPDATE`,
      [distributorId, deliveryId],
    );
    if (!fila) {
      throw new RendicionConflictoError(
        'No tenés una rendición abierta: abrila antes de registrar un cobro',
      );
    }
    return fila.settlement_id;
  }

  /** Ata un cobro de cuenta corriente a la rendición (suma al efectivo esperado). */
  async vincularCobro(
    manager: EntityManager,
    datos: { settlementId: string; entryId: string; amount: Decimal.Value },
  ): Promise<void> {
    await manager.insert(DriverSettlementCollection, {
      settlementId: datos.settlementId,
      entryId: datos.entryId,
      amount: aCentavos(datos.amount),
    });
    await manager.query(
      `UPDATE "driver_settlement" SET "expected_cash" = "expected_cash" + $2, "updatedAt" = now()
       WHERE "settlement_id" = $1`,
      [datos.settlementId, aCentavos(datos.amount)],
    );
  }

  private async bloquear(
    manager: EntityManager,
    id: string,
    distributorId: string,
    soloDelUsuario?: string,
  ): Promise<DriverSettlement> {
    const s = await manager.findOne(DriverSettlement, {
      where: { settlementId: id, distributorId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!s) throw new RendicionNoEncontradaError(id);
    if (soloDelUsuario) {
      const [chofer]: Array<{ user_id: string }> = await manager.query(
        `SELECT "user_id" FROM "delivery" WHERE "delivery_id" = $1`,
        [s.deliveryId],
      );
      if (chofer?.user_id !== soloDelUsuario) {
        throw new RendicionNoEncontradaError(id);
      }
    }
    return s;
  }

  /** Cada gasto necesita una categoría de egreso de la distribuidora. */
  private async validarCategoriasDeGasto(
    manager: EntityManager,
    distributorId: string,
    ids: string[],
  ): Promise<void> {
    for (const categoryId of new Set(ids)) {
      const categoria = await manager.findOne(CashCategory, {
        where: { categoryId, distributorId },
      });
      if (!categoria) {
        throw new RendicionInvalidaError(
          `La categoría del gasto no existe: ${categoryId}`,
        );
      }
      if (!categoria.isActive) {
        throw new RendicionInvalidaError(
          `La categoría "${categoria.name}" está desactivada: elegí otra`,
        );
      }
      if (categoria.direction !== CategoryDirection.EXPENSE) {
        throw new RendicionInvalidaError(
          `"${categoria.name}" no es una categoría de gastos`,
        );
      }
    }
  }
}
