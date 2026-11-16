import { EntityManager } from 'typeorm';

/** Quién recibió el pedido y dónde: lo mínimo para reconocer la entrega en la rendición. */
export interface ClienteDeEntrega {
  customerName: string | null;
  deliveryAddress: string | null;
}

interface FilaDireccion {
  formatted_address: string | null;
  street: string | null;
  city: string | null;
  floor: string | null;
  apartment: string | null;
}

/**
 * La dirección formateada por el geocodificador (que no trae piso ni depto) o la
 * armada con la calle; en los dos casos con piso y depto si existen.
 */
export function direccionDeEntrega(fila: FilaDireccion): string | null {
  const unidad = [
    fila.floor?.trim() ? `piso ${fila.floor.trim()}` : '',
    fila.apartment?.trim() ? `depto ${fila.apartment.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const formateada = fila.formatted_address?.trim();
  if (formateada) return [formateada, unidad].filter(Boolean).join(', ');
  const calle = fila.street?.trim();
  if (!calle) return null;
  return [calle, unidad, fila.city?.trim()].filter(Boolean).join(', ');
}

/** Nombre del cliente y dirección de entrega de cada pedido (sin contacto ni coordenadas). */
export async function clientesDeEntrega(
  manager: EntityManager,
  distributorId: string,
  orderIds: string[],
): Promise<Map<string, ClienteDeEntrega>> {
  if (orderIds.length === 0) return new Map();
  const filas: Array<
    FilaDireccion & { order_id: string; full_name: string | null }
  > = await manager.query(
    `SELECT o."order_id", u."full_name", a."formattedAddress" AS formatted_address,
              a."street", a."city", a."floor", a."apartment"
       FROM "order" o
       JOIN "user" u ON u."user_id" = o."customer_id"
       LEFT JOIN "user_address" a ON a."address_id" = o."address_id"
       WHERE o."distributor_id" = $1 AND o."order_id" = ANY($2::uuid[])`,
    [distributorId, orderIds],
  );
  return new Map(
    filas.map((f) => [
      f.order_id,
      {
        customerName: f.full_name?.trim() || null,
        deliveryAddress: direccionDeEntrega(f),
      },
    ]),
  );
}
