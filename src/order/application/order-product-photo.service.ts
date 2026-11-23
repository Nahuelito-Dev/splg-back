import { Injectable } from '@nestjs/common';
import { GasCylinderPhotoService } from '../../gascylinder/gascylinder-photo.service';
import type { OrderResponseDto } from '../dto/order-response.dto';

/**
 * Foto firmada del producto de cada renglón de los pedidos. Se resuelve en lote
 * por distribuidora: una lectura de `photo_key` por ids para toda la lista y
 * firma local. Un producto sin foto, de otra distribuidora o con la firma caída
 * deja `photoUrl` en `null` y el pedido sigue igual.
 */
@Injectable()
export class OrderProductPhotoService {
  constructor(private readonly productos: GasCylinderPhotoService) {}

  /** Completa `photoUrl` en el producto de cada renglón de cada pedido. */
  async completar(pedidos: readonly OrderResponseDto[]): Promise<void> {
    const idsPorDistribuidora = new Map<string, Set<string>>();
    for (const pedido of pedidos) {
      for (const renglon of pedido.items ?? []) {
        if (!renglon.cylinder) continue;
        const ids = idsPorDistribuidora.get(pedido.distributorId) ?? new Set();
        ids.add(renglon.cylinder.id);
        idsPorDistribuidora.set(pedido.distributorId, ids);
      }
    }
    if (idsPorDistribuidora.size === 0) return;
    const urls = new Map<string, Map<string, string | null>>();
    await Promise.all(
      [...idsPorDistribuidora].map(async ([distribuidora, ids]) => {
        urls.set(
          distribuidora,
          await this.productos.urlsPorId(distribuidora, ids),
        );
      }),
    );
    for (const pedido of pedidos) {
      const deLaDistribuidora = urls.get(pedido.distributorId);
      for (const renglon of pedido.items ?? []) {
        if (!renglon.cylinder) continue;
        renglon.cylinder.photoUrl =
          deLaDistribuidora?.get(renglon.cylinder.id) ?? null;
      }
    }
  }
}
