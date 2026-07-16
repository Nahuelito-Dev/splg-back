/**
 * PUERTO de envío de emails. `EmailService` habla con ESTA interfaz, no con
 * el SDK de Resend: "mandá este HTML a esta dirección" se expresa acá, y
 * `ResendEmailAdapter` (infrastructure) implementa el cómo contra Resend.
 *
 * Se declara como clase abstracta porque en NestJS es el token de inyección
 * idiomático para puertos (las interfaces no existen en runtime). Ver
 * ResendEmailAdapter (infrastructure) para la implementación concreta.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export abstract class EmailSenderPort {
  /**
   * Envía un email. Si la infraestructura de envío no está configurada
   * (ej. falta RESEND_API_KEY en dev/test), el adapter puede resolver sin
   * enviar nada (no-op). Si el envío falla, debe rechazar la promesa: el
   * caller (`EmailService`) decide si eso es best-effort o no.
   */
  abstract send(input: SendEmailInput): Promise<void>;
}
