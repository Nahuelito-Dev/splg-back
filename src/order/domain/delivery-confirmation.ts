import type { Point } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { Coordenada, distanciaEnMetros } from './chofer-por-terminar';

/** Lo que queda asentado en el pedido cuando se confirma la entrega. */
export interface ConfirmacionDeEntrega {
  /** Dónde estaba el chofer; `null` si confirmó un admin. */
  point: Point | null;
  accuracyM: number | null;
  distanceM: number | null;
  outOfRange: boolean;
  byUserId: string;
  byRole: RoleType.DELIVERY | RoleType.ADMIN | RoleType.SUPER_ADMIN;
}

/** La confirmación manual de un admin: sin ubicación, con su rol y su usuario. */
export function confirmacionDelAdmin(
  userId: string,
  role: RoleType.ADMIN | RoleType.SUPER_ADMIN,
): ConfirmacionDeEntrega {
  return {
    point: null,
    accuracyM: null,
    distanceM: null,
    outOfRange: false,
    byUserId: userId,
    byRole: role,
  };
}

export interface DistanciaDeConfirmacion {
  /** Metros al domicilio, redondeados; `null` si el pedido no tiene punto de entrega. */
  distanceM: number | null;
  /** Más lejos que el radio de llegada (con el radio en 0 el control está apagado). */
  outOfRange: boolean;
}

/**
 * Qué tan lejos del domicilio confirmó el chofer. No rechaza: sólo mide y
 * marca. Sin domicilio con coordenadas no hay con qué medir y no se marca.
 */
export function medirConfirmacion(
  posicion: Coordenada,
  destino: Coordenada | null,
  radioMetros: number,
): DistanciaDeConfirmacion {
  if (!destino) return { distanceM: null, outOfRange: false };
  const distancia = distanciaEnMetros(posicion, destino);
  return {
    distanceM: Math.round(distancia),
    outOfRange: radioMetros > 0 && distancia > radioMetros,
  };
}
