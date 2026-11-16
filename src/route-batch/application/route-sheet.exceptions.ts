import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { conCodigo } from '../../common/errors/con-codigo';
import { RouteSheetViolation } from '../domain/route-sheet-rules';

/**
 * Errores de la planificación y la edición de hojas: `code` estable en inglés
 * (lo reconoce el panel) y `message` en castellano.
 */
export const ROUTE_PLAN_CODES = {
  PLAN_NOT_FOUND: 'ROUTE_PLAN_NOT_FOUND',
  PLAN_DATE_PAST: 'ROUTE_PLAN_DATE_PAST',
  PLAN_CLOSED: 'ROUTE_PLAN_CLOSED',
  PLAN_BUSY: 'ROUTE_PLAN_BUSY',
  PLANNING_DISABLED: 'ROUTE_PLANNING_DISABLED',
  SHEET_NOT_FOUND: 'ROUTE_SHEET_NOT_FOUND',
  SHEET_VERSION_CONFLICT: 'ROUTE_SHEET_VERSION_CONFLICT',
  SHEET_NOT_EDITABLE: 'ROUTE_SHEET_NOT_EDITABLE',
  SHEET_BUSY: 'ROUTE_SHEET_BUSY',
  SHEET_NOT_CONFIRMABLE: 'ROUTE_SHEET_NOT_CONFIRMABLE',
  SHEET_OTHER_DAY: 'ROUTE_SHEET_OTHER_DAY',
  SHEET_SAME_TARGET: 'ROUTE_SHEET_SAME_TARGET',
  SHEET_SEQUENCE_INVALID: 'ROUTE_SHEET_SEQUENCE_INVALID',
  SHEET_DRIVER_TAKEN: 'ROUTE_SHEET_DRIVER_TAKEN',
  SHEET_CAR_TAKEN: 'ROUTE_SHEET_CAR_TAKEN',
  STOP_NOT_FOUND: 'ROUTE_STOP_NOT_FOUND',
  STOP_NOT_FEASIBLE: 'ROUTE_STOP_NOT_FEASIBLE',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_ALREADY_IN_ROUTE: 'ORDER_ALREADY_IN_ROUTE',
  ORDER_NOT_PLANNABLE: 'ORDER_NOT_PLANNABLE',
  DRIVER_NOT_FOUND: 'DRIVER_NOT_FOUND',
  CAR_NOT_FOUND: 'CAR_NOT_FOUND',
  WAREHOUSE_NOT_FOUND: 'WAREHOUSE_NOT_FOUND',
  HOLIDAY_NOT_FOUND: 'ROUTE_HOLIDAY_NOT_FOUND',
  HOLIDAY_DATE_PAST: 'ROUTE_HOLIDAY_DATE_PAST',
  HOLIDAY_ALREADY_EXISTS: 'ROUTE_HOLIDAY_ALREADY_EXISTS',
} as const;

const C = ROUTE_PLAN_CODES;

export const planNoEncontrado = () =>
  conCodigo(
    NotFoundException,
    404,
    'No hay planificación abierta para ese día',
    C.PLAN_NOT_FOUND,
  );

export const fechaPasada = () =>
  conCodigo(
    ConflictException,
    409,
    'No se puede planificar un día que ya pasó',
    C.PLAN_DATE_PAST,
  );

export const planCerrado = () =>
  conCodigo(
    ConflictException,
    409,
    'La planificación de ese día ya está cerrada',
    C.PLAN_CLOSED,
  );

export const planOcupado = () =>
  conCodigo(
    ConflictException,
    409,
    'Ya se está armando la propuesta de ese día: reintentá en un momento',
    C.PLAN_BUSY,
  );

export const planificacionApagada = () =>
  conCodigo(
    ConflictException,
    409,
    'La hoja de ruta está apagada para la distribuidora: encendela en los procesos automáticos',
    C.PLANNING_DISABLED,
  );

export const hojaNoEncontrada = () =>
  conCodigo(
    NotFoundException,
    404,
    'Hoja de ruta no encontrada',
    C.SHEET_NOT_FOUND,
  );

export const versionVieja = () =>
  conCodigo(
    ConflictException,
    409,
    'Otro administrador cambió esta hoja: actualizá la pantalla y volvé a intentar',
    C.SHEET_VERSION_CONFLICT,
  );

export const hojaNoEditable = () =>
  conCodigo(
    ConflictException,
    409,
    'Sólo se edita una hoja en borrador: reabrila para cambiarla',
    C.SHEET_NOT_EDITABLE,
  );

export const hojaNoCancelable = () =>
  conCodigo(
    ConflictException,
    409,
    'La hoja ya se inició o está cerrada: no se puede cancelar',
    C.SHEET_NOT_EDITABLE,
  );

export const hojaNoReabrible = () =>
  conCodigo(
    ConflictException,
    409,
    'Sólo se reabre una hoja confirmada que todavía no se inició',
    C.SHEET_NOT_EDITABLE,
  );

export const hojaOcupada = () =>
  conCodigo(
    ConflictException,
    409,
    'La hoja se está editando en otra sesión: reintentá en un momento',
    C.SHEET_BUSY,
  );

export const hojaOtroDia = () =>
  conCodigo(
    ConflictException,
    409,
    'Las dos hojas tienen que ser del mismo día',
    C.SHEET_OTHER_DAY,
  );

export const mismaHoja = () =>
  conCodigo(
    BadRequestException,
    400,
    'La hoja de destino tiene que ser otra',
    C.SHEET_SAME_TARGET,
  );

export const secuenciaInvalida = () =>
  conCodigo(
    BadRequestException,
    400,
    'El orden tiene que traer exactamente las paradas de la hoja, sin repetir',
    C.SHEET_SEQUENCE_INVALID,
  );

export const fijadasFueraDeLaHoja = () =>
  conCodigo(
    BadRequestException,
    400,
    'Las paradas fijadas tienen que ser de la hoja',
    C.SHEET_SEQUENCE_INVALID,
  );

export const choferConOtraHoja = () =>
  conCodigo(
    ConflictException,
    409,
    'El chofer ya tiene otra hoja confirmada ese día',
    C.SHEET_DRIVER_TAKEN,
  );

export const vehiculoConOtraHoja = () =>
  conCodigo(
    ConflictException,
    409,
    'El vehículo ya tiene otra hoja confirmada ese día',
    C.SHEET_CAR_TAKEN,
  );

export const paradaNoEncontrada = () =>
  conCodigo(
    NotFoundException,
    404,
    'El pedido no es una parada de esta hoja',
    C.STOP_NOT_FOUND,
  );

export const paradaNoFactible = (motivo: string) =>
  conCodigo(
    ConflictException,
    409,
    `El pedido no entra en la hoja: ${motivo}`,
    C.STOP_NOT_FEASIBLE,
  );

export const pedidoNoEncontrado = () =>
  conCodigo(NotFoundException, 404, 'Pedido no encontrado', C.ORDER_NOT_FOUND);

export const pedidoYaAgrupado = () =>
  conCodigo(
    ConflictException,
    409,
    'El pedido ya está en otra hoja o recorrido',
    C.ORDER_ALREADY_IN_ROUTE,
  );

export const pedidoNoPlanificable = (motivo: string) =>
  conCodigo(
    ConflictException,
    409,
    `El pedido no se puede planificar: ${motivo}`,
    C.ORDER_NOT_PLANNABLE,
  );

export const choferNoEncontrado = () =>
  conCodigo(NotFoundException, 404, 'Chofer no encontrado', C.DRIVER_NOT_FOUND);

export const vehiculoNoEncontrado = () =>
  conCodigo(NotFoundException, 404, 'Vehículo no encontrado', C.CAR_NOT_FOUND);

export const depositoNoEncontrado = () =>
  conCodigo(
    NotFoundException,
    404,
    'Depósito no encontrado',
    C.WAREHOUSE_NOT_FOUND,
  );

export const feriadoNoEncontrado = () =>
  conCodigo(
    NotFoundException,
    404,
    'Feriado no encontrado',
    C.HOLIDAY_NOT_FOUND,
  );

export const feriadoPasado = () =>
  conCodigo(
    ConflictException,
    409,
    'No se puede cargar un feriado en un día que ya pasó',
    C.HOLIDAY_DATE_PAST,
  );

export const feriadoRepetido = () =>
  conCodigo(
    ConflictException,
    409,
    'Ese día ya está cargado como feriado',
    C.HOLIDAY_ALREADY_EXISTS,
  );

/** 409 con la lista de lo que impide confirmar (el panel la muestra). */
export function noConfirmable(
  violations: readonly RouteSheetViolation[],
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: `No se puede confirmar la hoja: ${violations.map((v) => v.message).join('; ')}`,
    error: 'Conflict',
    code: C.SHEET_NOT_CONFIRMABLE,
    violations,
  });
}

// ───────────────────────── ejecución (E4) ─────────────────────────

export const ROUTE_SHEET_EXECUTION_CODES = {
  NOT_STARTABLE: 'ROUTE_SHEET_NOT_STARTABLE',
  NOT_TODAY: 'ROUTE_SHEET_NOT_TODAY',
  CAR_NOT_IN_USE: 'ROUTE_SHEET_CAR_NOT_IN_USE',
  DRIVER_UNAVAILABLE: 'ROUTE_SHEET_DRIVER_UNAVAILABLE',
  TRUCK_LOAD_REQUIRED: 'ROUTE_SHEET_TRUCK_LOAD_REQUIRED',
  TRUCK_LOAD_NOT_READY: 'ROUTE_SHEET_TRUCK_LOAD_NOT_READY',
  TRUCK_LOAD_OTHER_CAR: 'ROUTE_SHEET_TRUCK_LOAD_OTHER_CAR',
  SHORTAGES: 'ROUTE_SHEET_SHORTAGES',
  NOTHING_TO_START: 'ROUTE_SHEET_NOTHING_TO_START',
  NOT_IN_PROGRESS: 'ROUTE_SHEET_NOT_IN_PROGRESS',
  STOP_IN_PROGRESS: 'ROUTE_SHEET_STOP_IN_PROGRESS',
  STOP_NOT_PENDING: 'ROUTE_STOP_NOT_PENDING',
} as const;

const E = ROUTE_SHEET_EXECUTION_CODES;

export const hojaNoIniciable = () =>
  conCodigo(
    ConflictException,
    409,
    'Sólo se inicia el viaje de una hoja confirmada que todavía no salió',
    E.NOT_STARTABLE,
  );

export const hojaNoEsDeHoy = (fecha: string) =>
  conCodigo(
    ConflictException,
    409,
    `La hoja es del ${fecha.split('-').reverse().join('/')}: el viaje sólo se inicia el día del reparto`,
    E.NOT_TODAY,
  );

export function vehiculoNoEnUso(
  hojaPatente: string | null,
  enUsoPatente: string | null,
): ConflictException {
  const hoja = hojaPatente ?? 'el de la hoja';
  return new ConflictException({
    statusCode: 409,
    message: enUsoPatente
      ? `El vehículo en uso del chofer es la patente ${enUsoPatente} y la hoja es de la ${hoja}: el chofer tiene que tomar el vehículo de la hoja para iniciar el viaje`
      : `El chofer no tiene un vehículo en uso: tiene que tomar el de la hoja (${hoja}) para iniciar el viaje`,
    error: 'Conflict',
    code: E.CAR_NOT_IN_USE,
    sheetCarPatent: hojaPatente,
    carInUsePatent: enUsoPatente,
  });
}

export function choferNoHabilitado(motivos: string[]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: `El chofer no puede salir hoy: ${motivos.join('; ')}`,
    error: 'Conflict',
    code: E.DRIVER_UNAVAILABLE,
    reasons: motivos,
  });
}

export const cargaExigida = () =>
  conCodigo(
    ConflictException,
    409,
    'El viaje sale con la carga del camión: falta abrir la carga del chofer en el vehículo de la hoja',
    E.TRUCK_LOAD_REQUIRED,
  );

export const cargaNoLista = (numero: number, estado: string) =>
  conCodigo(
    ConflictException,
    409,
    estado === 'loading'
      ? `La carga N° ${numero} todavía no salió del depósito: hay que confirmar la salida del camión antes de iniciar el viaje`
      : `La carga N° ${numero} ya volvió: no se inicia un viaje hasta cerrar su rendición`,
    E.TRUCK_LOAD_NOT_READY,
  );

export const cargaEnOtroVehiculo = (
  numero: number,
  patenteCarga: string | null,
  patenteHoja: string | null,
) =>
  conCodigo(
    ConflictException,
    409,
    `La carga N° ${numero} del chofer está en la patente ${patenteCarga ?? '?'} y la hoja es de la ${patenteHoja ?? '?'}`,
    E.TRUCK_LOAD_OTHER_CAR,
  );

export function faltaStock(
  shortages: ReadonlyArray<{
    gasCylinderId: string;
    type: string | null;
    required: number;
    onTruck: number;
    missing: number;
  }>,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message:
      'Al camión le faltan garrafas para la hoja. Para salir igual, confirmá que sabés del faltante',
    error: 'Conflict',
    code: E.SHORTAGES,
    shortages,
  });
}

export const nadaParaIniciar = () =>
  conCodigo(
    ConflictException,
    409,
    'Ningún pedido de la hoja se pudo asignar (se cancelaron, se asignaron aparte o esperan el pago): la hoja sigue confirmada y el viaje no se inicia',
    E.NOTHING_TO_START,
  );

export const hojaNoEnCurso = () =>
  conCodigo(
    ConflictException,
    409,
    'La hoja no está en curso',
    E.NOT_IN_PROGRESS,
  );

export const otraParadaEnCamino = () =>
  conCodigo(
    ConflictException,
    409,
    'El chofer ya va en camino a otra parada: hay que entregarla o marcarla como no entregada antes de salir a otra',
    E.STOP_IN_PROGRESS,
  );

export const paradaNoPendiente = () =>
  conCodigo(
    ConflictException,
    409,
    'La parada ya se entregó o salió de la hoja',
    E.STOP_NOT_PENDING,
  );
