import { QueryStockMovementDto } from '../../stock/dto/query-stock.dto';
import type {
  StockMovementDto,
  StockSummaryDto,
} from '../../stock/dto/stock-response.dto';
import { StockQueryService } from '../../stock/application/stock-query.service';
import type { FuenteDeExporte } from '../export.types';
import { codigo, entero, fechaHora, opcion, texto } from './columnas';
import { fuente, porPagina, SinFiltros } from './fuente';

export interface ServiciosDeStock {
  stock: StockQueryService;
}

export function fuentesDeStock(s: ServiciosDeStock): FuenteDeExporte[] {
  return [
    fuente<SinFiltros, StockSummaryDto>({
      recurso: 'stock-resumen',
      descripcion:
        'Resumen de stock por tipo de garrafa: depósitos vs vehículos',
      query: SinFiltros,
      leer: async (_query, distribuidoraId) => {
        const filas = await s.stock.resumen(distribuidoraId);
        return { filas, total: filas.length };
      },
      columnas: [
        texto('Garrafa', (r) => r.gasCylinderType),
        entero('Depósitos: llenas', (r) => r.warehouses.full),
        entero('Depósitos: vacías', (r) => r.warehouses.empty),
        entero('Depósitos: defectuosas', (r) => r.warehouses.defective),
        entero('Vehículos: llenas', (r) => r.vehicles.full),
        entero('Vehículos: vacías', (r) => r.vehicles.empty),
        entero('Vehículos: defectuosas', (r) => r.vehicles.defective),
        entero('Llenas en total', (r) => r.physicalFull),
        entero('Reservadas', (r) => r.reserved),
        entero('Vendible', (r) => r.sellable),
        entero('Mínimo configurado', (r) => r.minimumFull),
      ],
    }),

    fuente<QueryStockMovementDto, StockMovementDto>({
      recurso: 'stock-movimientos',
      descripcion:
        'Libro de movimientos de stock (mismos filtros que GET /stock/movements)',
      query: QueryStockMovementDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.stock.movimientos(distribuidoraId, query);
        return { filas: r.data, total: r.total };
      },
      columnas: [
        fechaHora('Fecha', (m) => m.occurredAt),
        texto('Garrafa', (m) => m.gasCylinderType),
        entero('Cantidad', (m) => m.quantity),
        texto('Origen', (m) => m.from?.name),
        opcion('Condición de origen', 'condition', (m) => m.fromCondition),
        texto('Destino', (m) => m.to?.name),
        opcion('Condición de destino', 'condition', (m) => m.toCondition),
        opcion('Motivo', 'reason', (m) => m.reason),
        opcion('Tipo de referencia', 'referenceType', (m) => m.referenceType),
        codigo('Referencia', (m) => m.referenceId, 38),
        texto('Usuario', (m) => m.actorName),
        texto('Notas', (m) => m.notes, 36),
        codigo('Lote', (m) => m.batchId, 38),
        codigo('Anula al movimiento', (m) => m.reversedMovementId, 38),
      ],
    }),
  ];
}
