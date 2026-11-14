import { escaparHtml } from '../common/utils/html.util';
import { SendEmailInput } from './ports/email-sender.port';

/**
 * Redirección de desarrollo: con `EMAIL_REDIRECT_TO` cargada, todo correo va a
 * esa dirección en lugar de a su destinatario (así un entorno con datos de
 * prueba nunca le escribe a nadie más). Falla cerrada: sólo se activa si
 * `NODE_ENV` dice explícitamente `development` o `test`; en producción, o sin
 * `NODE_ENV`, se ignora siempre, esté o no la variable.
 */
export function destinoDeRedireccion(
  env: Record<string, string | undefined>,
): string | null {
  const entorno = env.NODE_ENV?.trim().toLowerCase();
  if (entorno !== 'development' && entorno !== 'test') return null;
  const destino = env.EMAIL_REDIRECT_TO?.trim();
  return destino ? destino : null;
}

/** Banda que se agrega arriba del cuerpo de un correo redirigido. */
function bandaHtml(original: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FEF0C7;border-bottom:1px solid #FEC84B;"><tr><td align="center" style="padding:10px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:18px;color:#7A2E0E;">Correo de prueba: era para <strong>${escaparHtml(original)}</strong></td></tr></table>`;
}

/**
 * El mismo correo, dirigido a `destino`: el asunto dice a quién iba
 * («[para: …]») y el cuerpo lleva una banda arriba con el destinatario original.
 */
export function redirigirCorreo(
  correo: SendEmailInput,
  destino: string,
): SendEmailInput {
  const original = correo.to;
  const banda = bandaHtml(original);
  const apertura = /<body[^>]*>/i.exec(correo.html);
  const html = apertura
    ? correo.html.slice(0, apertura.index + apertura[0].length) +
      banda +
      correo.html.slice(apertura.index + apertura[0].length)
    : banda + correo.html;
  return {
    ...correo,
    to: destino,
    subject: `[para: ${original}] ${correo.subject}`,
    html,
    ...(correo.text !== undefined
      ? { text: `Correo de prueba: era para ${original}\n\n${correo.text}` }
      : {}),
  };
}
