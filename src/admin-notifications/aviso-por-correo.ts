import {
  armarCorreo,
  BloqueDeCorreo,
  CorreoArmado,
} from '../email/layout/correo';
import { MarcaDeCorreo } from '../email/layout/marca-de-correo';
import { AdminNotification } from './entities/admin-notification.entity';

/** Pantalla del panel a la que lleva cada tipo de entidad; sin entrada, a la portada. */
const RUTA_DEL_PANEL: Readonly<Record<string, (id: string) => string>> = {
  order: (id) => `orders/${encodeURIComponent(id)}`,
  claim: () => 'claims',
  incident: () => 'incidents',
  'cylinder-recovery-case': (id) =>
    `physical-cylinders/recovery?case=${encodeURIComponent(id)}`,
  'fleet-task': (id) => `fleet/tasks/${encodeURIComponent(id)}`,
  employee: (id) => `employees/details/${encodeURIComponent(id)}?tab=documents`,
  'traffic-fine': (id) => `fleet/fines?fine=${encodeURIComponent(id)}`,
  'car-insurance': (id) =>
    `cars/details/${encodeURIComponent(id)}?tab=insurance`,
  'insurance-installment': () => 'notifications',
  'support-session': (id) => `support-access?session=${encodeURIComponent(id)}`,
  conversation: (id) => `messages/${encodeURIComponent(id)}`,
};

/** Ruta del panel (sin dominio) a la que lleva el aviso, o `null` si no apunta a nada. */
export function rutaDelPanelDelAviso(aviso: AdminNotification): string | null {
  if (!aviso.linkEntity || !aviso.linkId) return null;
  return RUTA_DEL_PANEL[aviso.linkEntity]?.(aviso.linkId) ?? '';
}

/** Lo que la bandeja muestra de un texto largo: la primera línea, recortada. */
function resumen(texto: string, largo = 140): string {
  const plano = texto.replace(/\s+/g, ' ').trim();
  return plano.length > largo ? `${plano.slice(0, largo - 1)}…` : plano;
}

/**
 * El correo de un aviso, con la marca de la distribuidora. El título y el
 * cuerpo los escribe quien emite el evento (a veces con texto de un cliente):
 * el layout los escapa.
 */
export function correoDelAviso(
  aviso: AdminNotification,
  urlDelPanel: string | null,
  marca: MarcaDeCorreo,
): CorreoArmado {
  const bloques: BloqueDeCorreo[] = [{ tipo: 'parrafo', texto: aviso.body }];
  if (urlDelPanel) {
    bloques.push({ tipo: 'boton', texto: 'Ver en el panel', url: urlDelPanel });
  }
  return armarCorreo(marca, {
    asunto: aviso.title,
    preheader: resumen(aviso.body),
    etiqueta: 'Aviso del panel',
    titulo: aviso.title,
    bloques,
  });
}
