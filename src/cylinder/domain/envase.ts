import { CylinderInspectionResult } from './cylinder-inspection-result';
import { CylinderState, FUERA_DEL_DEPOSITO } from './cylinder-state';
import { assertTransition } from './cylinder-state.machine';
import { estaVencido } from './cylinder-vigencia';
import {
  EnvaseEnConflictoError,
  EnvasesVencidosError,
  ReglaDeEnvaseError,
} from './errors/cylinder-rule.errors';
import { InvalidCylinderTransitionError } from './errors/invalid-cylinder-transition.error';
import type { RevisionPlanificada } from './revision-de-envase';
import { serialCanonico } from './serial-de-envase';

/** Tolerancia entre el reloj del cliente y el del servidor al validar fechas "no futuras". */
const MARGEN_FECHA_FUTURA_MS = 5 * 60 * 1000;

/** Lo que se sabe de un envase físico. */
export interface DatosDeEnvase {
  cylinderId: string;
  distributorId: string;
  /** Número de serie grabado en el envase; único por distribuidora. */
  serial: string;
  /** Producto al que corresponde (ej. "Garrafa 10kg"). */
  gasCylinderId: string | null;
  state: CylinderState;
  /** Cliente que lo tiene; sólo en `with_customer`. */
  currentCustomerId: string | null;
  /** Pedido en el que salió despachado. */
  currentOrderId: string | null;
  deposit: number;
  photoKey: string | null;
  manufacturedAt: Date | null;
  lastInspectionAt: Date | null;
  /** Hasta cuándo puede circular; `null` sin revisión registrada. */
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Datos con los que nace un envase: en el depósito y sin dueño. */
export interface NuevoEnvase {
  distributorId: string;
  serial: string;
  gasCylinderId: string | null;
  deposit: number;
  state: CylinderState.IN_DEPOT;
}

/** Un asiento del historial del envase (append-only). */
export interface MovimientoDeEnvase {
  cylinderId: string;
  distributorId: string;
  /** `null` en el alta. */
  fromState: CylinderState | null;
  toState: CylinderState;
  orderId: string | null;
  actorUserId: string | null;
  note: string | null;
}

/** Una revisión para asentar en el historial de revisiones. */
export interface NuevaRevision {
  cylinderId: string;
  distributorId: string;
  inspectedAt: Date;
  result: CylinderInspectionResult;
  nextDueAt: Date | null;
  notes: string | null;
}

/** Contexto de una transición: en qué pedido ocurre, quién la hace y por qué. */
export interface ContextoDeTransicion {
  orderId?: string | null;
  actorUserId?: string | null;
  note?: string | null;
  /** Titular del pedido: queda como tenedor al pasar a `with_customer`. */
  customerId?: string | null;
}

/** Datos maestros editables; el estado y la vigencia no se editan. */
export interface CambiosDeEnvase {
  serial?: string;
  gasCylinderId?: string;
  deposit?: number;
  manufacturedAt?: Date;
}

/** Lo que deja una revisión: el asiento y, si corresponde, la marca en el historial. */
export interface RevisionRegistrada {
  revision: NuevaRevision;
  /** `false` si era anterior a la última cargada: sólo entra al historial. */
  actualizaFicha: boolean;
  movimiento: MovimientoDeEnvase | null;
}

/** Datos del alta de un envase, con el serial ya en su forma canónica. */
export function nuevoEnvase(
  distributorId: string,
  datos: { serial: string; gasCylinderId?: string | null; deposit?: number },
): NuevoEnvase {
  return {
    distributorId,
    serial: serialCanonico(datos.serial),
    gasCylinderId: datos.gasCylinderId ?? null,
    deposit: datos.deposit ?? 0,
    state: CylinderState.IN_DEPOT,
  };
}

/** El primer asiento del historial: el envase entra al depósito. */
export function movimientoDeAlta(envase: Envase): MovimientoDeEnvase {
  return {
    cylinderId: envase.cylinderId,
    distributorId: envase.distributorId,
    fromState: null,
    toState: CylinderState.IN_DEPOT,
    orderId: null,
    actorUserId: null,
    note: null,
  };
}

/**
 * Agregado ENVASE: una garrafa física con su serial. Es el único lugar donde
 * cambia su estado, su tenedor, su pedido y su vigencia; cada cambio de estado
 * devuelve el movimiento que hay que asentar en el historial.
 */
export class Envase {
  private constructor(private readonly datos: DatosDeEnvase) {}

  /** Reconstruye el agregado a partir de lo guardado. */
  static rehidratar(datos: DatosDeEnvase): Envase {
    return new Envase({ ...datos });
  }

  get cylinderId(): string {
    return this.datos.cylinderId;
  }
  get distributorId(): string {
    return this.datos.distributorId;
  }
  get serial(): string {
    return this.datos.serial;
  }
  get state(): CylinderState {
    return this.datos.state;
  }
  get currentCustomerId(): string | null {
    return this.datos.currentCustomerId;
  }
  get currentOrderId(): string | null {
    return this.datos.currentOrderId;
  }
  get expiresAt(): Date | null {
    return this.datos.expiresAt;
  }

  /** Copia de los datos, para persistir o mostrar. */
  snapshot(): DatosDeEnvase {
    return { ...this.datos };
  }

  /** Con la revisión vencida no puede salir a reparto; sin fecha cargada, sí. */
  estaVencido(ahora: Date): boolean {
    return estaVencido(this.datos.expiresAt, ahora);
  }

  /**
   * Cambia de estado según la máquina de estados. Efectos sobre el tenedor:
   *  - WITH_CUSTOMER: el titular del pedido.
   *  - EMPTY_RETURNED / IN_DEPOT / RETIRED: nadie.
   * y sobre el pedido:
   *  - DISPATCHED: el de la transición.
   *  - WITH_CUSTOMER: el de la transición o, si no viene, el que ya tenía.
   *  - IN_DEPOT / RETIRED: ninguno (el envase vuelve a estar libre).
   *  - EMPTY_RETURNED: conserva el pedido con el que salió.
   * Toda puerta al despacho pasa por acá: un envase vencido no sale (CU-135).
   */
  transicionar(
    toState: CylinderState,
    ctx: ContextoDeTransicion,
    ahora: Date,
  ): MovimientoDeEnvase {
    const fromState = this.datos.state;
    assertTransition(fromState, toState);
    if (toState === CylinderState.DISPATCHED && this.estaVencido(ahora)) {
      throw new EnvasesVencidosError([this.datos.serial]);
    }

    if (toState === CylinderState.WITH_CUSTOMER) {
      this.datos.currentCustomerId = ctx.customerId ?? null;
    } else if (
      toState === CylinderState.EMPTY_RETURNED ||
      toState === CylinderState.IN_DEPOT ||
      toState === CylinderState.RETIRED
    ) {
      this.datos.currentCustomerId = null;
    }

    if (toState === CylinderState.DISPATCHED) {
      this.datos.currentOrderId = ctx.orderId ?? null;
    } else if (toState === CylinderState.WITH_CUSTOMER) {
      this.datos.currentOrderId = ctx.orderId ?? this.datos.currentOrderId;
    } else if (
      toState === CylinderState.IN_DEPOT ||
      toState === CylinderState.RETIRED
    ) {
      this.datos.currentOrderId = null;
    }

    this.datos.state = toState;
    return {
      cylinderId: this.datos.cylinderId,
      distributorId: this.datos.distributorId,
      fromState,
      toState,
      orderId: ctx.orderId ?? null,
      actorUserId: ctx.actorUserId ?? null,
      note: ctx.note ?? null,
    };
  }

  /**
   * Baja común (estado terminal). Uno en poder de un cliente no se da de baja
   * así: se da por perdido con `darPorPerdido`.
   */
  darDeBaja(
    reason: string,
    actorUserId: string | undefined,
    ahora: Date,
  ): MovimientoDeEnvase {
    if (this.datos.state === CylinderState.WITH_CUSTOMER) {
      throw new InvalidCylinderTransitionError(
        this.datos.state,
        CylinderState.RETIRED,
      );
    }
    return this.transicionar(
      CylinderState.RETIRED,
      { actorUserId, note: `Baja: ${reason}` },
      ahora,
    );
  }

  /** Baja por pérdida (CU-108): sólo si sigue en poder de un cliente. */
  darPorPerdido(
    reason: string,
    actorUserId: string,
    ahora: Date,
  ): MovimientoDeEnvase {
    if (this.datos.state !== CylinderState.WITH_CUSTOMER) {
      throw new EnvaseEnConflictoError(
        'El envase ya no está en poder de un cliente: el caso de recupero cambió',
      );
    }
    return this.transicionar(
      CylinderState.RETIRED,
      { actorUserId, note: `Baja por pérdida: ${reason}` },
      ahora,
    );
  }

  /** Edita los datos maestros. Un envase dado de baja ya no se edita. */
  editar(cambios: CambiosDeEnvase, ahora: Date): void {
    if (this.datos.state === CylinderState.RETIRED) {
      throw new EnvaseEnConflictoError(
        'El envase está dado de baja y no se edita',
      );
    }
    const { manufacturedAt } = cambios;
    if (
      manufacturedAt !== undefined &&
      manufacturedAt.getTime() > ahora.getTime() + MARGEN_FECHA_FUTURA_MS
    ) {
      throw new ReglaDeEnvaseError(
        'Fecha de fabricación: la fecha de fabricación no puede ser futura',
      );
    }
    if (
      manufacturedAt !== undefined &&
      this.datos.expiresAt &&
      manufacturedAt.getTime() > this.datos.expiresAt.getTime()
    ) {
      throw new ReglaDeEnvaseError(
        'La fecha de fabricación no puede ser posterior al vencimiento del envase',
      );
    }
    if (cambios.serial !== undefined) {
      this.datos.serial = serialCanonico(cambios.serial);
    }
    if (cambios.gasCylinderId !== undefined) {
      this.datos.gasCylinderId = cambios.gasCylinderId;
    }
    if (cambios.deposit !== undefined) this.datos.deposit = cambios.deposit;
    if (manufacturedAt !== undefined) {
      this.datos.manufacturedAt = manufacturedAt;
    }
  }

  /**
   * CU-132. Asienta la revisión y, si es la más reciente, copia en la ficha la
   * última fecha y el vencimiento. Un rechazo vence en el acto (el inicio del
   * día de la revisión ya pasó), así el envase queda alcanzado por el bloqueo
   * del despacho sin otra regla. Rechazado y afuera: no cambia de estado, pero
   * queda marcado en el historial para retirarlo cuando vuelva.
   */
  registrarRevision(
    plan: RevisionPlanificada,
    actorUserId?: string,
  ): RevisionRegistrada {
    if (this.datos.state === CylinderState.RETIRED) {
      throw new EnvaseEnConflictoError(
        'El envase está dado de baja y no admite revisiones',
      );
    }
    if (
      this.datos.manufacturedAt &&
      plan.inspectedAt.getTime() < this.datos.manufacturedAt.getTime()
    ) {
      throw new ReglaDeEnvaseError(
        'La revisión no puede ser anterior a la fabricación del envase',
      );
    }
    const revision: NuevaRevision = {
      cylinderId: this.datos.cylinderId,
      distributorId: this.datos.distributorId,
      inspectedAt: plan.inspectedAt,
      result: plan.result,
      nextDueAt: plan.vence,
      notes: plan.notes,
    };
    const esLaMasReciente =
      !this.datos.lastInspectionAt ||
      plan.inspectedAt.getTime() >= this.datos.lastInspectionAt.getTime();
    if (!esLaMasReciente) {
      return { revision, actualizaFicha: false, movimiento: null };
    }

    this.datos.lastInspectionAt = plan.inspectedAt;
    this.datos.expiresAt = plan.vence ?? plan.inspectedAt;
    const marcar =
      plan.rechazada && FUERA_DEL_DEPOSITO.includes(this.datos.state);
    return {
      revision,
      actualizaFicha: true,
      movimiento: marcar
        ? {
            cylinderId: this.datos.cylinderId,
            distributorId: this.datos.distributorId,
            fromState: this.datos.state,
            toState: this.datos.state,
            orderId: null,
            actorUserId: actorUserId ?? null,
            note: 'Revisión rechazada: retirar el envase cuando vuelva',
          }
        : null,
    };
  }
}
