import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import { ahoraDeLaBase } from '../../stock/application/reloj-de-la-base';
import { StockLocationService } from '../../stock/application/stock-location.service';
import { StockOnHandService } from '../../stock/application/stock-on-hand.service';
import { StockLedgerPort } from '../../stock/domain/ports/stock-ledger.port';
import { claveDeSaldo } from '../../stock/domain/stock-rules';
import {
  StockCondition,
  StockReferenceType,
} from '../../stock/domain/stock.enums';
import { CargaInvalidaError } from '../domain/errors/truck-load.errors';
import {
  entregasTardias,
  estadoDeCierre,
  planDeCierre,
  puedeHacer,
  renglonesDeCierre,
} from '../domain/truck-load-rules';
import { CloseTruckLoadDto } from '../dto/truck-load.dto';
import { TruckLoadItem } from '../entities/truck-load-item.entity';
import {
  TransicionDeCargaInvalidaError,
  bloquearCarga,
} from './truck-load-support';

/**
 * Cierra la rendición. En UNA transacción:
 *  1. lock de la carga y de todo lo que se va a tocar, en el orden del ledger
 *     (garrafas, depósito, saldos): una entrega en curso se ve completa antes
 *     de calcular y una posterior ya no encuentra stock en el camión;
 *  2. esperado por tipo = cargado + repuesto - entregado (llenas) y cargadas +
 *     recolectadas (vacías), con lo entregado leído del libro;
 *  3. el ledger devuelve lo declarado camión -> depósito (`truck_return`) y
 *     registra la diferencia como merma (`shrinkage`) o sobrante (`adjustment`),
 *     de modo que el camión queda en cero;
 *  4. se congelan las cifras en los renglones y la carga queda `closed` o
 *     `closed_with_difference` (con nota obligatoria).
 */
@Injectable()
export class CloseTruckLoadUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: StockLedgerPort,
    private readonly locations: StockLocationService,
    private readonly onHand: StockOnHandService,
  ) {}

  async execute(
    id: string,
    dto: CloseTruckLoadDto,
    distributorId: string,
    actorUserId: string,
  ): Promise<void> {
    await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const carga = await bloquearCarga(manager, id, distributorId);
          if (!puedeHacer('cerrar', carga.status)) {
            throw new TransicionDeCargaInvalidaError(
              carga.number,
              carga.status,
              'cerrar la rendición: el chofer tiene que declarar la vuelta primero',
            );
          }
          const items = await manager.find(TruckLoadItem, {
            where: { loadId: id },
          });
          const camion = await this.locations.ubicacionDeVehiculo(
            manager,
            distributorId,
            carga.carId,
          );
          // Lo que el camión tiene y la carga no lista (una transferencia a mano):
          // se rinde igual, con renglón propio, para que el camión quede en cero.
          const sinRenglon = (
            await this.onHand.tiposConSaldo(manager, camion.locationId)
          ).filter((g) => !items.some((i) => i.gasCylinderId === g));
          const saldos = await this.onHand.bloquearParaRendicion(manager, {
            distributorId,
            gasCylinderIds: [
              ...items.map((i) => i.gasCylinderId),
              ...sinRenglon,
            ],
            depositLocationId: carga.originLocationId,
            truckLocationId: camion.locationId,
          });
          const movidos = new Map(
            (
              await this.onHand.movimientosDelCamion(
                manager,
                camion.locationId,
                carga.openedAt,
              )
            ).map((m) => [m.gasCylinderId, m]),
          );
          // Una entrega del camión DESPUÉS de declarar la vuelta deja la
          // declaración vieja: se pediría un físico que ya no es el del camión.
          // Se rechaza (409) y se vuelve a declarar, en vez de recalcular en
          // silencio contra un conteo que el chofer no hizo.
          const tardias = entregasTardias(
            await this.onHand.movimientosDelCamion(
              manager,
              camion.locationId,
              carga.returnedAt!,
            ),
          );
          if (tardias > 0) {
            throw new ConflictException(
              `Se entregaron ${tardias} garrafas del camión después de declarar la vuelta: el chofer tiene que volver a declarar lo que trae antes de cerrar`,
            );
          }
          const saldoDe = (g: string, c: StockCondition) =>
            saldos.get(claveDeSaldo(camion.locationId, g, c)) ?? 0;

          const { renglones, figuras } = renglonesDeCierre({
            items,
            sinRenglon,
            movidos,
            saldoDe: (g) => ({
              full: saldoDe(g, StockCondition.FULL),
              empty: saldoDe(g, StockCondition.EMPTY),
              defective: saldoDe(g, StockCondition.DEFECTIVE),
            }),
          });

          const plan = planDeCierre(
            camion.locationId,
            carga.originLocationId,
            renglones,
          );
          const nota = dto.differenceNote?.trim() || null;
          if (plan.hayDiferencia && !nota) {
            throw new CargaInvalidaError(
              'La rendición tiene diferencias entre lo esperado y lo declarado: indicá la nota de la diferencia (merma, pérdida o sobrante) para cerrarla',
            );
          }
          if (plan.movimientos.length > 0) {
            await this.ledger.aplicar(manager, {
              distributorId,
              referenceType: StockReferenceType.TRUCK_LOAD,
              referenceId: carga.loadId,
              actorUserId,
              notes: `Rendición del camión (carga N° ${carga.number})`.slice(
                0,
                300,
              ),
              movimientos: plan.movimientos,
            });
          }

          const porGarrafa = new Map(
            renglones.map((r, i) => [r.gasCylinderId, plan.renglones[i]]),
          );
          for (const item of items) {
            const r = renglones.find(
              (x) => x.gasCylinderId === item.gasCylinderId,
            )!;
            const f = figuras.get(item.gasCylinderId)!;
            item.deliveredFull = f.deliveredFull;
            item.collectedEmpty = f.collectedEmpty;
            item.expectedFull = r.expectedFull;
            item.expectedEmpty = r.expectedEmpty;
            item.declaredReturnFull = r.declaredFull;
            item.declaredReturnEmpty = r.declaredEmpty;
            item.differenceFull = porGarrafa.get(
              item.gasCylinderId,
            )!.differenceFull;
            item.differenceEmpty = porGarrafa.get(
              item.gasCylinderId,
            )!.differenceEmpty;
          }
          await manager.save(items);
          await manager.save(
            sinRenglon.map((g) => {
              const f = figuras.get(g)!;
              const d = porGarrafa.get(g)!;
              return manager.create(TruckLoadItem, {
                loadId: id,
                gasCylinderId: g,
                deliveredFull: f.deliveredFull,
                collectedEmpty: f.collectedEmpty,
                expectedFull: 0,
                expectedEmpty: 0,
                declaredReturnFull: 0,
                declaredReturnEmpty: 0,
                differenceFull: d.differenceFull,
                differenceEmpty: d.differenceEmpty,
              });
            }),
          );
          carga.status = estadoDeCierre(plan.hayDiferencia);
          carga.closedAt = await ahoraDeLaBase(manager);
          carga.closedByUserId = actorUserId;
          carga.differenceNote = plan.hayDiferencia ? nota : null;
          await manager.save(carga);
        }),
      { context: 'rendición del camión' },
    );
  }
}
