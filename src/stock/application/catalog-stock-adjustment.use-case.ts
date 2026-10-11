import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StockInsuficienteError } from '../domain/errors/stock.errors';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { StockAdjustmentReason, StockCondition } from '../domain/stock.enums';
import { StockAdjustmentUseCase } from './stock-adjustment.use-case';
import { WarehouseService } from './warehouse.service';

export const NOTA_AJUSTE_DE_CATALOGO =
  'Ajuste manual de stock desde el catálogo de productos';

/**
 * El ajuste manual del catálogo (`PATCH /gascylinder/:id/stock`) como un ajuste
 * de conteo de llenas en el depósito predeterminado (diseño M-C §4.3 punto 8).
 */
@Injectable()
export class CatalogStockAdjustmentUseCase {
  constructor(
    private readonly products: GasCylinderService,
    private readonly warehouses: WarehouseService,
    private readonly adjustments: StockAdjustmentUseCase,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async execute(
    gasCylinderId: string,
    quantity: number,
    distributorId: string,
    actorUserId: string,
  ): Promise<GasCylinder> {
    // 404 si el producto no es de la distribuidora, antes de tocar nada.
    await this.products.findOne(gasCylinderId, distributorId);
    if (quantity !== 0) {
      const { warehouse } =
        await this.warehouses.asegurarPredeterminado(distributorId);
      try {
        await this.adjustments.execute(
          {
            location: { warehouseId: warehouse.warehouseId },
            reason: StockAdjustmentReason.COUNT_CORRECTION,
            notes: NOTA_AJUSTE_DE_CATALOGO,
            items: [
              {
                gasCylinderId,
                condition: StockCondition.FULL,
                quantityDelta: quantity,
              },
            ],
          },
          distributorId,
          actorUserId,
        );
      } catch (error) {
        if (error instanceof StockInsuficienteError && quantity < 0) {
          throw await this.mensajeConDondeEstan(
            error,
            gasCylinderId,
            distributorId,
          );
        }
        throw error;
      }
    }
    return this.products.findOne(gasCylinderId, distributorId);
  }

  /**
   * El ajuste del catálogo siempre actúa sobre el depósito predeterminado. Si
   * ahí no alcanzan las llenas, el mensaje dice dónde están las que faltan.
   */
  private async mensajeConDondeEstan(
    error: StockInsuficienteError,
    gasCylinderId: string,
    distributorId: string,
  ): Promise<BadRequestException> {
    const [fila]: Array<{ camiones: number; otros: number }> =
      await this.dataSource.query(
        `SELECT COALESCE(SUM(b."quantity") FILTER (WHERE l."kind" = 'vehicle'), 0)::int AS camiones,
                COALESCE(SUM(b."quantity") FILTER (WHERE l."kind" = 'warehouse' AND l."warehouse_id" <> w."warehouse_id"), 0)::int AS otros
         FROM "stock_balance" b
         JOIN "stock_location" l ON l."location_id" = b."location_id"
         LEFT JOIN "warehouse" w ON w."distributor_id" = b."distributor_id" AND w."is_default" AND w."deletedAt" IS NULL
         WHERE b."gas_cylinder_id" = $1 AND b."distributor_id" = $2 AND b."condition" = 'full'`,
        [gasCylinderId, distributorId],
      );
    const disponibles = error.faltantes[0]?.available ?? 0;
    const donde: string[] = [];
    if (fila.camiones > 0) donde.push(`${fila.camiones} en camiones`);
    if (fila.otros > 0) donde.push(`${fila.otros} en otros depósitos`);
    return new BadRequestException(
      `El depósito predeterminado sólo tiene ${disponibles} llenas de este producto.` +
        (donde.length > 0
          ? ` Las demás están ${donde.join(' y ')}: transferilas al depósito predeterminado o ajustá ahí (POST /stock/adjustments con el vehículo o el depósito).`
          : ' No hay más llenas en ningún lado: revisá el físico.'),
    );
  }
}
