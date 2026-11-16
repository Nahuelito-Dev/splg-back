import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { EntityManager } from 'typeorm';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { StockAdjustmentUseCase } from '../../stock/application/stock-adjustment.use-case';
import { StockQueryService } from '../../stock/application/stock-query.service';
import { WarehouseService } from '../../stock/application/warehouse.service';
import { OperacionDeStockInvalidaError } from '../../stock/domain/errors/stock.errors';
import { validarItemsDeAjuste } from '../../stock/domain/stock-rules';
import {
  StockAdjustmentReason,
  StockCondition,
} from '../../stock/domain/stock.enums';
import { AdjustmentItemDto } from '../../stock/dto/stock-operations.dto';
import { ImportResource } from '../domain/import.enums';
import {
  ColumnaDeImportacion,
  ContextoDeAplicacion,
  ErrorDeFila,
  FilaCruda,
  FilaNormalizada,
  ImportHandler,
  ResultadoDeValidacion,
  ResumenDeImportacion,
} from '../domain/import.types';
import { normalizarEncabezado } from '../parsing/tabla-importada';
import {
  claveNormal,
  conContexto,
  numeroDeCelda,
  validarConDto,
} from './validacion-de-filas';

const COLUMNAS: ColumnaDeImportacion[] = [
  {
    key: 'warehouse',
    header: 'Depósito',
    ejemplo: 'CENTRAL',
    obligatoria: true,
  },
  { key: 'type', header: 'Tipo', ejemplo: '10 kg', obligatoria: true },
  {
    key: 'condition',
    header: 'Condición',
    ejemplo: 'llena',
    obligatoria: true,
  },
  {
    key: 'quantityDelta',
    header: 'Variación',
    ejemplo: '40',
    obligatoria: true,
  },
];

const CONDICIONES: Record<string, StockCondition> = {
  llena: StockCondition.FULL,
  llenas: StockCondition.FULL,
  full: StockCondition.FULL,
  vacia: StockCondition.EMPTY,
  vacias: StockCondition.EMPTY,
  empty: StockCondition.EMPTY,
  defectuosa: StockCondition.DEFECTIVE,
  defectuosas: StockCondition.DEFECTIVE,
  defective: StockCondition.DEFECTIVE,
};

/** Tope de ítems por ajuste, el mismo del alta unitaria (`CreateAdjustmentDto`). */
const ITEMS_POR_AJUSTE = 50;

interface DatosDeStock {
  warehouseId: string;
  warehouse: string;
  gasCylinderId: string;
  type: string;
  condition: StockCondition;
  quantityDelta: number;
}

function esDatosDeStock(
  datos: Record<string, unknown>,
): datos is Record<string, unknown> & DatosDeStock {
  return (
    typeof datos.warehouseId === 'string' &&
    typeof datos.warehouse === 'string' &&
    typeof datos.gasCylinderId === 'string' &&
    typeof datos.quantityDelta === 'number' &&
    typeof datos.condition === 'string'
  );
}

/**
 * Stock inicial o ajuste por depósito: cada fila es la variación de una garrafa
 * y condición en un depósito. Se aplica como ajustes `count_correction` (uno por
 * depósito, partidos de a 50 renglones) con el caso de uso del ajuste: queda el
 * documento numerado, el libro de movimientos y el vendible alineado.
 */
@Injectable()
export class StockImportHandler implements ImportHandler {
  readonly recurso = ImportResource.STOCK;
  readonly columnas = COLUMNAS;

  constructor(
    private readonly garrafas: GasCylinderService,
    private readonly depositos: WarehouseService,
    private readonly ajustes: StockAdjustmentUseCase,
    private readonly saldos: StockQueryService,
  ) {}

  async validar(
    filas: FilaCruda[],
    distributorId: string,
  ): Promise<ResultadoDeValidacion> {
    const catalogo = new Map(
      (await this.garrafas.tiposDelCatalogo(distributorId)).map((g) => [
        claveNormal(g.type),
        g,
      ]),
    );
    const galpones = new Map(
      (await this.depositos.findAll(distributorId)).map((d) => [
        claveNormal(d.warehouse.code),
        d.warehouse,
      ]),
    );
    // Saldo actual por depósito, tipo y condición: una baja que lo deja negativo se
    // marca en la vista previa y no recién al confirmar.
    const saldoActual = new Map(
      (await this.saldos.saldos(distributorId, { includeZero: true }))
        .filter((s) => s.warehouseId !== null)
        .map((s) => [
          `${s.warehouseId}|${s.gasCylinderId}|${s.condition}`,
          s.quantity,
        ]),
    );
    const vistos = new Map<string, number>();
    const errores: ErrorDeFila[] = [];
    const validas: FilaNormalizada[] = [];

    for (const { fila, celdas } of filas) {
      const erroresDeFila: ErrorDeFila[] = [];
      const error = (i: number, mensaje: string): void => {
        erroresDeFila.push({ fila, columna: COLUMNAS[i].header, mensaje });
      };

      const deposito = galpones.get(claveNormal(celdas.warehouse));
      if (celdas.warehouse === '') error(0, 'es obligatorio');
      else if (!deposito) {
        error(
          0,
          `No hay un depósito activo con el código "${celdas.warehouse}"`,
        );
      }

      const garrafa = catalogo.get(claveNormal(celdas.type));
      if (celdas.type === '') error(1, 'es obligatorio');
      else if (!garrafa) {
        error(1, 'No existe una garrafa con ese tipo en tu distribuidora');
      } else if (!garrafa.isActive) {
        error(
          1,
          'La garrafa está dada de baja: reactivala antes de mover su stock',
        );
      }

      const condicion = CONDICIONES[normalizarEncabezado(celdas.condition)];
      if (celdas.condition === '') error(2, 'es obligatorio');
      else if (!condicion) {
        error(
          2,
          `"${celdas.condition}" no es una condición válida: usá llena, vacía o defectuosa`,
        );
      }

      const variacion = numeroDeCelda(
        celdas.quantityDelta,
        fila,
        COLUMNAS[3],
        erroresDeFila,
      );
      const resultado = await validarConDto(
        AdjustmentItemDto,
        {
          gasCylinderId: garrafa?.gasCylinderId,
          condition: condicion,
          quantityDelta: variacion,
        },
        fila,
        COLUMNAS,
        celdas,
      );
      // Sólo los errores propios del número: el resto ya se marcó arriba.
      const conError = new Set(erroresDeFila.map((e) => e.columna));
      erroresDeFila.push(
        ...resultado.errores.filter(
          (e) => e.columna === COLUMNAS[3].header && !conError.has(e.columna),
        ),
      );

      if (resultado.dto) {
        try {
          validarItemsDeAjuste(StockAdjustmentReason.COUNT_CORRECTION, [
            resultado.dto,
          ]);
        } catch (e) {
          if (!(e instanceof OperacionDeStockInvalidaError)) throw e;
          error(3, e.message);
        }
      }

      if (deposito && garrafa && condicion) {
        const clave = `${deposito.warehouseId}|${garrafa.gasCylinderId}|${condicion}`;
        const previa = vistos.get(clave);
        if (previa !== undefined) {
          error(
            1,
            `Ya hay una fila para este depósito, tipo y condición (fila ${previa})`,
          );
        } else {
          vistos.set(clave, fila);
        }
        const hay = saldoActual.get(clave) ?? 0;
        if (variacion !== undefined && hay + variacion < 0) {
          error(
            3,
            `Dejaría el stock en negativo: hay ${hay} y la variación es ${variacion}`,
          );
        }
      }

      if (erroresDeFila.length > 0 || !resultado.dto || !deposito || !garrafa) {
        errores.push(...erroresDeFila);
        continue;
      }
      validas.push({
        fila,
        datos: {
          warehouseId: deposito.warehouseId,
          warehouse: deposito.code,
          gasCylinderId: garrafa.gasCylinderId,
          type: garrafa.type,
          condition: resultado.dto.condition,
          quantityDelta: resultado.dto.quantityDelta,
        },
      });
    }
    return { errores, filas: validas };
  }

  async aplicar(
    manager: EntityManager,
    filas: FilaNormalizada[],
    ctx: ContextoDeAplicacion,
  ): Promise<ResumenDeImportacion> {
    const porDeposito = new Map<
      string,
      { codigo: string; items: AdjustmentItemDto[] }
    >();
    for (const { datos } of filas) {
      if (!esDatosDeStock(datos)) continue;
      const grupo = porDeposito.get(datos.warehouseId) ?? {
        codigo: datos.warehouse,
        items: [],
      };
      grupo.items.push(
        plainToInstance(AdjustmentItemDto, {
          gasCylinderId: datos.gasCylinderId,
          condition: datos.condition,
          quantityDelta: datos.quantityDelta,
        }),
      );
      porDeposito.set(datos.warehouseId, grupo);
    }

    let ajustes = 0;
    for (const [warehouseId, { codigo, items }] of porDeposito) {
      for (let i = 0; i < items.length; i += ITEMS_POR_AJUSTE) {
        try {
          await this.ajustes.ejecutarEn(
            manager,
            {
              location: { warehouseId },
              reason: StockAdjustmentReason.COUNT_CORRECTION,
              notes: `Importación masiva de stock (${ctx.fileName})`.slice(
                0,
                500,
              ),
              items: items.slice(i, i + ITEMS_POR_AJUSTE),
            },
            ctx.distributorId,
            ctx.actorUserId,
          );
        } catch (error) {
          throw conContexto(error, `Depósito ${codigo}`);
        }
        ajustes++;
      }
    }
    return {
      filasAplicadas: filas.length,
      ajustes,
      depositos: porDeposito.size,
    };
  }
}
