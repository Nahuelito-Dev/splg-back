import type { CylinderInspectionResult } from '../cylinder-inspection-result';
import type { CylinderState } from '../cylinder-state';
import type { FiltroDeVigencia } from '../cylinder-vigencia';
import type { DatosDeEnvase } from '../envase';

/** El envase como se muestra: sus datos y, si la consulta los trae, su producto y su tenedor. */
export interface EnvaseVista extends DatosDeEnvase {
  gasCylinder?: {
    type: string;
    weight: number;
    photoKey: string | null;
    photoSignedUrl?: string | null;
  };
  currentCustomer?: {
    userId: string;
    fullName?: string;
    phoneNumber?: string;
  };
  /** URL firmada de la foto; la completa quien arma la respuesta. */
  photoSignedUrl?: string | null;
  /** Fecha del último movimiento; sólo la trae el listado. */
  lastMovementAt?: Date | null;
}

export interface MovimientoVista {
  movementId: string;
  cylinderId: string;
  distributorId: string;
  fromState: CylinderState | null;
  toState: CylinderState;
  orderId: string | null;
  actorUserId: string | null;
  note: string | null;
  createdAt: Date;
}

export interface RevisionVista {
  inspectionId: string;
  cylinderId: string;
  inspectedAt: Date;
  result: CylinderInspectionResult;
  nextDueAt: Date | null;
  notes: string | null;
}

/** Filtros del listado de envases. */
export interface FiltrosDeEnvases {
  state?: CylinderState;
  orderId?: string;
  /** user_id del cliente. */
  customerUserId?: string;
  gasCylinderId?: string;
  /** Vigencia de la revisión (CU-135 paso 5: buscar un reemplazo). */
  vigencia?: FiltroDeVigencia;
  /** Sin `limit` no pagina. */
  limit?: number;
  offset?: number;
}

/** Grupos del listado de vencimientos (CU-134). */
export type GrupoDeVencimiento = 'expired' | 'expiring' | 'unverified';

export interface ConsultaDeVencimientos {
  ahora: Date;
  /** Fin de la ventana de "por vencer". */
  limite: Date;
  distributorId?: string | null;
  limit: number;
  offset: number;
}

/**
 * PUERTO de lectura de envases: devuelve vistas para mostrar, no el agregado.
 * Sin `distributorId` no acota por distribuidora (super administrador).
 */
export abstract class CylinderQueryPort {
  /**
   * Listado con producto, tenedor y fecha del último movimiento. El filtro por
   * pedido incluye los envases que alguna vez se movieron en ese pedido.
   * Devuelve la página y el total sin paginar.
   */
  abstract listar(
    distributorId: string | null | undefined,
    filtros: FiltrosDeEnvases,
    ahora: Date,
  ): Promise<[EnvaseVista[], number]>;

  /** Detalle con producto y tenedor. */
  abstract buscarPorId(
    cylinderId: string,
    distributorId?: string | null,
  ): Promise<EnvaseVista | null>;

  /** Por serial en su forma canónica, sin relaciones. */
  abstract buscarPorSerial(
    serial: string,
    distributorId: string,
  ): Promise<EnvaseVista | null>;

  /** Por id o por serial canónico, con su producto (ficha de vigencia). */
  abstract buscarConProducto(
    criterio: { cylinderId: string } | { serial: string },
    distributorId?: string | null,
  ): Promise<EnvaseVista | null>;

  /** Movimientos del envase, del más antiguo al más nuevo. */
  abstract historial(cylinderId: string): Promise<MovimientoVista[]>;

  /** Revisiones del envase, de la más reciente a la más antigua. */
  abstract revisiones(cylinderId: string): Promise<RevisionVista[]>;

  /** Un grupo del listado de vencimientos (sin los dados de baja) y su total. */
  abstract vencimientos(
    grupo: GrupoDeVencimiento,
    consulta: ConsultaDeVencimientos,
  ): Promise<[EnvaseVista[], number]>;
}
