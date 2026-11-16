import {
  BadRequestDomainError,
  ConflictDomainError,
  NotFoundDomainError,
} from '../../common/errors/domain.error';
import { CODIGOS_DE_ERROR } from '../../common/errors/con-codigo';

/** La conversación no existe, es de otra empresa o de un canal que no corresponde. */
export class ConversacionNoEncontradaError extends NotFoundDomainError {
  constructor() {
    super('No existe esa conversación');
  }
}

export class TicketNoEncontradoError extends NotFoundDomainError {
  constructor() {
    super('No existe ese ticket');
  }
}

export class ConversacionCerradaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.CONVERSATION_CLOSED;
  constructor() {
    super('La conversación está cerrada.');
  }
}

export class TicketCerradoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_CLOSED;
  constructor() {
    super('El ticket está cerrado. Si el problema sigue, abrí uno nuevo.');
  }
}

export class TicketNoResueltoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_NOT_RESOLVED;
  constructor() {
    super('El ticket todavía no está resuelto.');
  }
}

/** Una transición que la máquina del ticket no permite (§4.2.2). */
export class TransicionDeTicketInvalidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_INVALID_TRANSITION;
  constructor(de: string, a: string) {
    super(`No se puede pasar el ticket de ${de} a ${a}.`);
  }
}

/** Rango de mensajes del chat fuera del chat, invertido o de más de 200 mensajes. */
export class CitaInvalidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.TICKET_EXCERPT_INVALID;
  constructor() {
    super('Elegí entre 1 y 200 mensajes del chat.');
  }
}

/** Nota interna donde no va: sólo la plataforma en un ticket (D-C8) o el personal en su bandeja. */
export class NotaInternaNoPermitidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.INTERNAL_NOTE_NOT_ALLOWED;
  constructor() {
    super(
      'Las notas internas sólo las deja el equipo: en un ticket o en la bandeja de mensajes.',
    );
  }
}

/** Mencionar en una nota a alguien que no es del personal que atiende ese canal (4a). */
export class MencionNoPermitidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.MENTION_NOT_ALLOWED;
  constructor() {
    super(
      'Sólo podés mencionar a alguien del equipo que atienda estos mensajes.',
    );
  }
}

/** La conversación ya la atiende otra persona de la plataforma. */
export class ConversacionYaTomadaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.CONVERSATION_ALREADY_TAKEN;
  constructor() {
    super('Otra persona del soporte ya está atendiendo este chat.');
  }
}

/** Reabrir: hay otra abierta del mismo tema, o el canal no se reabre. */
export class ConversacionNoReabribleError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.CONVERSATION_NOT_REOPENABLE;
  constructor() {
    super(
      'Esta conversación no se puede reabrir: ya hay otra abierta sobre el mismo tema.',
    );
  }
}

export class ConversacionConReclamoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.CONVERSATION_ALREADY_HAS_CLAIM;
  constructor() {
    super('Esta conversación ya tiene un reclamo.');
  }
}

/** Abrir una conversación por un pedido entregado o cancelado hace más de 30 días. */
export class PlazoDelPedidoVencidoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.ORDER_CHAT_WINDOW_CLOSED;
  constructor() {
    super(
      'Pasó el plazo para consultar por este pedido. Escribinos por el chat general.',
    );
  }
}

/** Asignar a alguien del personal que no atiende ese canal. */
export class AsignadoSinPermisoError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.ASSIGNEE_WITHOUT_PERMISSION;
  constructor() {
    super('Esa persona no atiende este tipo de mensajes.');
  }
}

/** Editar un mensaje de sistema, una respuesta automática o uno ya redactado. */
export class MensajeNoEditableError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.MESSAGE_NOT_EDITABLE;
  constructor() {
    super('Este mensaje no se puede editar.');
  }
}

export class VentanaDeEdicionVencidaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.MESSAGE_EDIT_WINDOW_CLOSED;
  constructor(minutos: number) {
    super(
      `Ya no se puede editar: los mensajes se editan hasta ${minutos} minutos después de enviarlos.`,
    );
  }
}

/** Responder a un mensaje que no existe en esa conversación. */
export class RespuestaInvalidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.REPLY_TO_INVALID;
  constructor() {
    super('El mensaje al que respondés no existe en esta conversación.');
  }
}

/** Una plantilla con una variable fuera de la lista cerrada. */
export class VariableDePlantillaDesconocidaError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.TEMPLATE_VARIABLE_UNKNOWN;
  constructor(variables: readonly string[]) {
    super(
      `La respuesta usa variables que no existen: ${variables.join(', ')}. Usá ${'{{cliente.nombre}}'}, ${'{{pedido.numero}}'}, ${'{{empresa.nombre}}'} o ${'{{horario.proximo}}'}.`,
    );
  }
}

/** El nombre del asistente es una firma: sólo admite `{{empresa.nombre}}`. */
export class VariableDelNombreDelAsistenteError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.TEMPLATE_VARIABLE_UNKNOWN;
  constructor(variables: readonly string[]) {
    super(
      `El nombre del asistente no puede usar ${variables.map((v) => `{{${v}}}`).join(', ')}. Sólo admite ${'{{empresa.nombre}}'}.`,
    );
  }
}

/** El nombre del asistente fuera de largo o en más de una línea (la misma regla que el DTO y la base). */
export class NombreDelAsistenteInvalidoError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.ASSISTANT_NAME_INVALID;
  constructor() {
    super(
      'El nombre del asistente tiene que tener entre 2 y 60 caracteres, en una sola línea.',
    );
  }
}

/** Una punta escribiendo en un canal que no es suyo (no debería llegar: lo cubre la búsqueda). */
export class PuntaFueraDeSuCanalError extends ConflictDomainError {
  constructor() {
    super('No podés escribir en esta conversación.');
  }
}

/** Abrir con el chofer de un pedido que todavía no tiene chofer. */
export class PedidoSinChoferError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.ORDER_WITHOUT_DRIVER;
  constructor() {
    super('El pedido todavía no tiene chofer asignado.');
  }
}

/** Borrar un mensaje después de los 15 minutos (D-C23). */
export class VentanaDeBorradoVencidaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.MESSAGE_DELETE_WINDOW_CLOSED;
  constructor(minutos: number) {
    super(
      `Ya no se puede borrar: los mensajes se borran hasta ${minutos} minutos después de enviarlos.`,
    );
  }
}

/** El mensaje dio pie a un reclamo o está citado en un reclamo o un ticket. */
export class MensajeConReclamoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.MESSAGE_LINKED_TO_CLAIM;
  constructor(accion: AccionSobreElMensaje = 'borrar') {
    super(
      `No se puede ${accion}: el mensaje forma parte de un reclamo o de un ticket.`,
    );
  }
}

/** Editar o borrar: los dos tienen las mismas excepciones (D-C22, D-C23). */
export type AccionSobreElMensaje = 'borrar' | 'editar';

/** Los mensajes de una conversación por un pedido no se borran (son parte del pedido). */
export class MensajeDeUnPedidoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.MESSAGE_IN_ORDER_CONVERSATION;
  constructor(accion: AccionSobreElMensaje = 'borrar') {
    super(
      `No se puede ${accion}: los mensajes de una conversación por un pedido quedan como constancia del pedido.`,
    );
  }
}

/** Alguien ya respondió citando el mensaje. */
export class MensajeYaCitadoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.MESSAGE_ALREADY_QUOTED;
  constructor(accion: AccionSobreElMensaje = 'borrar') {
    super(`No se puede ${accion}: ya respondieron citando este mensaje.`);
  }
}

/** La persona ya no es de la empresa (chofer dado de baja, cliente sin vínculo ni pedidos). */
export class ChatNoEscribibleError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.CHAT_NOT_WRITABLE;
  constructor() {
    super('Ya no se puede escribir en este chat.');
  }
}

/** No hay encuesta para responder en esa conversación (4b). */
export class CalificacionNoDisponibleError extends NotFoundDomainError {
  override readonly code = CODIGOS_DE_ERROR.RATING_NOT_FOUND;
  constructor() {
    super('No hay una encuesta para responder en esta conversación.');
  }
}

/** La encuesta ya se respondió: una respuesta por cierre (4b). */
export class CalificacionYaRespondidaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.RATING_ALREADY_ANSWERED;
  constructor() {
    super('Ya calificaste esta conversación.');
  }
}

/** La encuesta de ese cierre se anuló: la conversación se reabrió (4b). */
export class CalificacionAnuladaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.RATING_CANCELLED;
  constructor() {
    super(
      'La conversación se volvió a abrir: esta encuesta ya no se puede responder.',
    );
  }
}

/** La encuesta venció (4b). */
export class CalificacionVencidaError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.RATING_EXPIRED;
  constructor(horas: number) {
    super(
      `La encuesta venció: se puede responder hasta ${horas} horas después de cerrada la conversación.`,
    );
  }
}

/** La empresa no muestra esa acción en el chat (4e). */
export class AccionNoDisponibleError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.ACTION_NOT_AVAILABLE;
  constructor() {
    super('Esa opción no está disponible en el chat de la distribuidora.');
  }
}

/** La acción la hace la app (repetir el pedido), no el chat (4e). */
export class AccionSoloDeLaAppError extends BadRequestDomainError {
  override readonly code = CODIGOS_DE_ERROR.ACTION_IS_APP_ONLY;
  constructor() {
    super('Esa opción se hace desde la app, no desde el chat.');
  }
}

/** El mensaje no tiene un adjunto que quien pide pueda ver: no existe, es de otra conversación o empresa, se redactó o se bloqueó por virus. */
export class AdjuntoNoEncontradoError extends NotFoundDomainError {
  constructor() {
    super('No existe ese archivo');
  }
}

/** El antivirus todavía no revisó el archivo (§9.3). */
export class AdjuntoEnEscaneoError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.ATTACHMENT_SCAN_PENDING;
  constructor() {
    super('Estamos verificando el archivo.');
  }
}

/** El antivirus no pudo revisar el archivo: sólo lo baja el personal (§9.3). */
export class AdjuntoSinVerificarError extends ConflictDomainError {
  override readonly code = CODIGOS_DE_ERROR.ATTACHMENT_SCAN_FAILED;
  constructor() {
    super('No pudimos verificar este archivo, así que no se puede abrir.');
  }
}
