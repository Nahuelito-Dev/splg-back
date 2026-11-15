import { Channel, MessageKind, SubjectType } from './chat.enums';
import {
  type AccionSobreElMensaje,
  MensajeConReclamoError,
  MensajeDeUnPedidoError,
  MensajeNoEditableError,
  MensajeYaCitadoError,
  PlazoDelPedidoVencidoError,
  VariableDePlantillaDesconocidaError,
  VentanaDeBorradoVencidaError,
  VentanaDeEdicionVencidaError,
} from './chat.errors';

/**
 * Reglas de la bandeja de la empresa (C2 choferes y C3 clientes, diseño §4.3,
 * §4.4, §5.1, §8.4 y §21). Puras: sin base ni Nest.
 */

/** Los permisos del personal que atienden cada canal de la bandeja. */
export type PermisoDeMensajes = 'mensajes.clientes' | 'mensajes.choferes';

export type CanalDeLaBandeja = Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;

export function permisoDelCanal(canal: CanalDeLaBandeja): PermisoDeMensajes {
  return canal === Channel.STAFF_CUSTOMER
    ? 'mensajes.clientes'
    : 'mensajes.choferes';
}

/** Los canales que atiende alguien con esos permisos (un admin sin ninguno no ve la bandeja). */
export function canalesQueAtiende(
  permisos: readonly string[],
): CanalDeLaBandeja[] {
  const canales: CanalDeLaBandeja[] = [];
  if (permisos.includes('mensajes.clientes')) {
    canales.push(Channel.STAFF_CUSTOMER);
  }
  if (permisos.includes('mensajes.choferes')) {
    canales.push(Channel.STAFF_DRIVER);
  }
  return canales;
}

/** Días después de entregado o cancelado en que todavía se abre una conversación por el pedido (§4.3). */
export const DIAS_PARA_CONSULTAR_UN_PEDIDO = 30;

/** Lo que importa del pedido para abrir una conversación por él. */
export interface PedidoConsultable {
  status: string;
  /** Cuándo terminó: entregado o cancelado; nulo si sigue en curso. */
  terminadoEn: Date | null;
}

/**
 * Se puede abrir una conversación por el pedido desde que existe hasta 30 días
 * después de entregado o cancelado (después, la general). 409 si pasó.
 */
export function assertSePuedeConsultarPorElPedido(
  pedido: PedidoConsultable,
  ahora: Date,
): void {
  const terminado =
    pedido.status === 'delivered' || pedido.status === 'cancelled';
  if (!terminado || !pedido.terminadoEn) return;
  const limite =
    pedido.terminadoEn.getTime() + DIAS_PARA_CONSULTAR_UN_PEDIDO * 864e5;
  if (ahora.getTime() > limite) throw new PlazoDelPedidoVencidoError();
}

/** El ámbito pedido: `order` exige el pedido; `general`, que no venga. */
export function ambitoValido(
  subjectType: SubjectType,
  orderId: string | null | undefined,
): boolean {
  if (subjectType === SubjectType.ORDER) return !!orderId;
  if (subjectType === SubjectType.GENERAL) return !orderId;
  return false;
}

/** Plazo para editar un mensaje propio (D-C22). Que sea de quien edita y que la conversación esté abierta lo controla el servicio. */
export const VENTANA_DE_EDICION_MINUTOS = 15;

/**
 * A qué quedó atado un mensaje: lo que impide editarlo o borrarlo (D-C22,
 * D-C23). Lo calcula el servicio contra la base.
 */
export interface AtadurasDelMensaje {
  /** La conversación es por un pedido. */
  deUnPedido: boolean;
  /** Dio pie a un reclamo (anterior a crearlo) o está citado en un reclamo o un ticket. */
  enUnReclamo: boolean;
  /** Algún mensaje lo cita (`replyToSeq`). */
  citado: boolean;
}

export const SIN_ATADURAS: AtadurasDelMensaje = {
  deUnPedido: false,
  enUnReclamo: false,
  citado: false,
};

function assertSinAtaduras(
  a: AtadurasDelMensaje,
  accion: AccionSobreElMensaje,
): void {
  if (a.deUnPedido) throw new MensajeDeUnPedidoError(accion);
  if (a.enUnReclamo) throw new MensajeConReclamoError(accion);
  if (a.citado) throw new MensajeYaCitadoError(accion);
}

export interface MensajeAEditar extends Partial<AtadurasDelMensaje> {
  kind: MessageKind;
  createdAt: Date;
  redactedAt: Date | null;
  deletedAt: Date | null;
  /** Lo borró su autor (D-C23): ya no se edita. */
  withdrawnAt: Date | null;
}

/**
 * Editar un mensaje propio (D-C22): texto de una persona, sin redactar, borrar
 * ni dar de baja, dentro de los 15 minutos y con las mismas excepciones que el
 * borrado (pedido, reclamo o ticket, ya citado): lo que quedó como constancia
 * no se reescribe.
 */
export function assertSePuedeEditar(m: MensajeAEditar, ahora: Date): void {
  if (
    m.kind !== MessageKind.TEXT ||
    m.redactedAt ||
    m.deletedAt ||
    m.withdrawnAt
  ) {
    throw new MensajeNoEditableError();
  }
  const limite = m.createdAt.getTime() + VENTANA_DE_EDICION_MINUTOS * 60_000;
  if (ahora.getTime() > limite) {
    throw new VentanaDeEdicionVencidaError(VENTANA_DE_EDICION_MINUTOS);
  }
  assertSinAtaduras({ ...SIN_ATADURAS, ...m }, 'editar');
}

/** Variables de las respuestas guardadas de la empresa (§6.8): lista cerrada. */
export const VARIABLES_DE_PLANTILLA = [
  'cliente.nombre',
  'pedido.numero',
  'empresa.nombre',
  'horario.proximo',
] as const;

export type VariableDePlantilla = (typeof VARIABLES_DE_PLANTILLA)[number];

const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Las variables que usa un texto, sin repetir. */
export function variablesDe(texto: string): string[] {
  return [...new Set([...texto.matchAll(VARIABLE)].map((m) => m[1]))];
}

/** 400 si el texto usa una variable fuera de la lista. */
export function assertVariablesConocidas(texto: string): void {
  const desconocidas = variablesDe(texto).filter(
    (v) => !(VARIABLES_DE_PLANTILLA as readonly string[]).includes(v),
  );
  if (desconocidas.length > 0) {
    throw new VariableDePlantillaDesconocidaError(desconocidas);
  }
}

/**
 * Reemplaza las variables por sus valores. Una que no tiene valor en esta
 * conversación (`{{pedido.numero}}` en una general) queda vacía.
 */
export function completarPlantilla(
  texto: string,
  valores: Partial<Record<VariableDePlantilla, string>>,
): string {
  return texto
    .replace(VARIABLE, (_, nombre: string) =>
      nombre in valores ? (valores[nombre as VariableDePlantilla] ?? '') : '',
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Lo que se sabe de la conversación C3 al llegar un mensaje del cliente. */
export interface SituacionDeLaBandeja {
  /** La empresa atiende ahora (su horario y sus días sin atención). */
  enHorario: boolean;
  /** Responder fuera de horario está prendido. */
  fueraDeHorarioHabilitado: boolean;
  /** Ya se respondió fuera de horario en este período cerrado. */
  yaSeRespondioEnEstePeriodo: boolean;
  /** El aviso de recibido en horario está prendido. */
  avisoDeRecibidoHabilitado: boolean;
  /** Ya se mandó el aviso de recibido en esta conversación. */
  yaSeAvisoRecibido: boolean;
  /** Alguien de la empresa ya escribió en esta conversación. */
  empresaYaEscribio: boolean;
}

/**
 * La respuesta automática al mensaje del cliente (§8.4, D-C29): fuera de
 * horario, una sola por período cerrado; en horario, el aviso de recibido una
 * vez por conversación y sólo si nadie de la empresa escribió todavía.
 */
export function respuestaAutomaticaDeLaEmpresa(
  s: SituacionDeLaBandeja,
): 'fuera_de_horario' | 'recibido' | null {
  if (!s.enHorario) {
    return s.fueraDeHorarioHabilitado && !s.yaSeRespondioEnEstePeriodo
      ? 'fuera_de_horario'
      : null;
  }
  return s.avisoDeRecibidoHabilitado &&
    !s.yaSeAvisoRecibido &&
    !s.empresaYaEscribio
    ? 'recibido'
    : null;
}

/** Textos por omisión de las respuestas automáticas de la empresa. */
export const FUERA_DE_HORARIO_POR_DEFECTO =
  'Ahora estamos fuera de horario. Te respondemos {{horario.proximo}}.';
export const RECIBIDO_POR_DEFECTO =
  'Recibimos tu mensaje. Alguien del equipo de {{empresa.nombre}} te va a atender a la brevedad.';

/** Tope de destinatarios de un mensaje a varios choferes (§4.4). */
export const TOPE_DE_CHOFERES_POR_ENVIO = 50;

/** Plazo para borrar un mensaje propio (D-C23). */
export const VENTANA_DE_BORRADO_MINUTOS = 15;

/** Lo que importa para decidir si el cliente puede borrar su mensaje. */
export interface MensajeABorrar extends AtadurasDelMensaje {
  kind: MessageKind;
  createdAt: Date;
  redactedAt: Date | null;
}

/**
 * Borrar un mensaje propio (D-C23): sólo texto del cliente, en C3, hasta 15
 * minutos después de enviarlo y si no quedó atado a nada (pedido, reclamo,
 * ticket o una respuesta que lo cita). Que sea del cliente, que sea suyo y que
 * no esté ya borrado lo controla el servicio.
 */
export function assertSePuedeBorrar(m: MensajeABorrar, ahora: Date): void {
  if (m.kind !== MessageKind.TEXT || m.redactedAt) {
    throw new MensajeNoEditableError();
  }
  if (
    ahora.getTime() >
    m.createdAt.getTime() + VENTANA_DE_BORRADO_MINUTOS * 60_000
  ) {
    throw new VentanaDeBorradoVencidaError(VENTANA_DE_BORRADO_MINUTOS);
  }
  assertSinAtaduras(m, 'borrar');
}
