import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import { PuntoDeRuta } from '../../routes/polyline';
import { RoutePathService } from '../../routes/route-path.service';
import { RouteSheetPathDto } from '../presentation/dto/route-sheet-path.dto';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetQueryService } from './route-sheet-query.service';

/** Un punto del recorrido: el depósito (`orderId` null) o una parada. */
interface PuntoDeLaHoja extends PuntoDeRuta {
  orderId: string | null;
}

/**
 * Recorrido por calles de una hoja para el mapa del panel: depósito → paradas
 * activas en el orden vigente → depósito. Las paradas sin coordenadas se
 * saltean (y se informan); sin paradas con coordenadas, el recorrido viene
 * vacío. El cálculo, la caché y el cupo los pone `RoutePathService`; la clave
 * de la caché es la hoja más la firma de sus puntos en orden, así que una hoja
 * que no cambió no vuelve a consultar al proveedor y cambiar el orden sí.
 */
@Injectable()
export class RouteSheetPathService {
  constructor(
    private readonly query: RouteSheetQueryService,
    private readonly data: RouteSheetDataService,
    @InjectRepository(RouteBatchStop)
    private readonly stops: Repository<RouteBatchStop>,
    private readonly paths: RoutePathService,
  ) {}

  async recorrido(
    distributorId: string,
    id: string,
  ): Promise<RouteSheetPathDto> {
    // Lo ajeno o inexistente es 404 (ROUTE_SHEET_NOT_FOUND).
    const hoja = await this.query.detalleSinMapear(distributorId, id);
    const paradas = await this.stops.find({
      where: { batchId: hoja.batchId, active: true },
      order: { sequence: 'ASC' },
    });
    const pedidos = new Map(
      (
        await this.data.pedidos(
          distributorId,
          paradas.map((p) => p.orderId),
        )
      ).map((p) => [p.orderId, p]),
    );
    const ubicadas: PuntoDeLaHoja[] = [];
    const salteadas: string[] = [];
    for (const parada of paradas) {
      const p = pedidos.get(parada.orderId);
      if (p && p.lat !== null && p.lng !== null) {
        ubicadas.push({ orderId: parada.orderId, lat: p.lat, lng: p.lng });
      } else {
        salteadas.push(parada.orderId);
      }
    }
    const deposito = await this.data.deposito(
      distributorId,
      hoja.originWarehouseId,
    );
    const base: RouteSheetPathDto = {
      sheetId: hoja.batchId,
      version: hoja.version,
      provider: null,
      distanceMeters: 0,
      durationSeconds: 0,
      encodedPolyline: '',
      legs: [],
      skippedOrderIds: salteadas,
      warehouse: deposito
        ? {
            warehouseId: deposito.warehouseId,
            lat: deposito.lat,
            lng: deposito.lng,
          }
        : null,
    };
    const galpon: PuntoDeLaHoja[] = deposito
      ? [{ orderId: null, lat: deposito.lat, lng: deposito.lng }]
      : [];
    const puntos =
      ubicadas.length > 0 ? [...galpon, ...ubicadas, ...galpon] : [];
    if (puntos.length < 2) return base;

    const recorrido = await this.paths.trazar(
      distributorId,
      `${hoja.batchId}:${firma(puntos)}`,
      puntos,
    );
    return {
      ...base,
      provider: recorrido.provider,
      distanceMeters: recorrido.distanceMeters,
      durationSeconds: recorrido.durationSeconds,
      encodedPolyline: recorrido.encodedPolyline,
      // El tramo i llega al punto i + 1.
      legs: recorrido.legs.map((l, i) => ({
        orderId: puntos[i + 1].orderId,
        distanceMeters: l.distanceMeters,
        durationSeconds: l.durationSeconds,
      })),
    };
  }
}

/** Huella de los puntos en orden (pedido y coordenadas): cambia si cambia cualquiera. */
export function firma(puntos: readonly PuntoDeLaHoja[]): string {
  const texto = puntos
    .map((p) => `${p.orderId ?? 'deposito'}@${p.lat},${p.lng}`)
    .join('|');
  return createHash('sha256').update(texto).digest('hex').slice(0, 32);
}
