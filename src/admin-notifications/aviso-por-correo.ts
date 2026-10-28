import { escaparHtml } from '../common/utils/html.util';
import { AdminNotification } from './entities/admin-notification.entity';

/** Pantalla del panel a la que lleva cada tipo de entidad; sin entrada, a la portada. */
const RUTA_DEL_PANEL: Readonly<Record<string, (id: string) => string>> = {
  order: (id) => `orders/${encodeURIComponent(id)}`,
  claim: () => 'claims',
  incident: () => 'incidents',
};

/** Ruta del panel (sin dominio) a la que lleva el aviso, o `null` si no apunta a nada. */
export function rutaDelPanelDelAviso(aviso: AdminNotification): string | null {
  if (!aviso.linkEntity || !aviso.linkId) return null;
  return RUTA_DEL_PANEL[aviso.linkEntity]?.(aviso.linkId) ?? '';
}

/**
 * HTML del correo de un aviso. El título y el cuerpo los escribe quien emite el
 * evento (a veces con texto de un cliente): se escapan.
 */
export function htmlDelAviso(
  aviso: AdminNotification,
  urlDelPanel: string | null,
): string {
  const enlace = urlDelPanel
    ? `<p><a href="${escaparHtml(urlDelPanel)}">Ver en el panel</a></p>`
    : '';
  return `<h2>${escaparHtml(aviso.title)}</h2><p>${escaparHtml(aviso.body).replace(/\n/g, '<br>')}</p>${enlace}`;
}
