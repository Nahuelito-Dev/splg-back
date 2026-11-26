export enum NotificationChannel {
  PUSH = 'push',
  EMAIL = 'email',
}

export enum NotificationStatus {
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/**
 * Lo que un envío puede contar de sí mismo al registrarse. Todo es opcional:
 * lo que el que envía no pasa queda en `null` (la distribuidora se completa
 * con la del pedido cuando hay `orderId`).
 */
export interface AvisoContexto {
  distributorId?: string | null;
  /** Tipo del aviso (`ORDER_CONFIRMATION`, `CASH_READY`…). */
  type?: string;
  recipientUserId?: string | null;
  orderId?: string | null;
}

export const TIPO_SIN_DATO = 'UNKNOWN';
const LARGO_MAXIMO_ERROR = 300;
const LARGO_MAXIMO_TITULO = 200;
const LARGO_MAXIMO_TIPO = 60;

/** `nahuel@dominio.com` → `n***@dominio.com`. */
export function enmascararCorreo(correo: string): string {
  const limpio = correo.trim();
  const arroba = limpio.lastIndexOf('@');
  if (arroba <= 0) return '***';
  return `${limpio[0]}***${limpio.slice(arroba)}`.slice(0, 120);
}

/** Del token del dispositivo sólo quedan los últimos 6 caracteres. */
export function enmascararToken(token: string): string {
  const limpio = token.trim();
  return limpio.length <= 6 ? '***' : `***${limpio.slice(-6)}`;
}

const CORREO_EN_TEXTO = /[^\s<>"'(),;:]+@[^\s<>"'(),;]+\.[^\s<>"'(),;]+/g;
const TOKEN_LARGO_EN_TEXTO = /[A-Za-z0-9_:\-.]{40,}/g;
// Siete o más dígitos, aunque vengan separados (+54 9 351 555-1212, (0351) 555 1212).
const NUMERO_LARGO_EN_TEXTO = /\+?\d(?:[\s\-().]*\d){6,}/g;

/**
 * El error del proveedor puede traer el correo, el token del dispositivo o
 * números largos (teléfonos, documentos): nada de eso se guarda.
 */
export function sanearError(texto: string): string {
  return texto
    .replace(CORREO_EN_TEXTO, '[correo]')
    .replace(TOKEN_LARGO_EN_TEXTO, '[token]')
    .replace(NUMERO_LARGO_EN_TEXTO, '[número]');
}

export function recortarError(error: unknown): string {
  const texto = error instanceof Error ? error.message : String(error);
  return sanearError(texto.replace(/\s+/g, ' ').trim()).slice(
    0,
    LARGO_MAXIMO_ERROR,
  );
}

export function recortarTitulo(
  titulo: string | undefined | null,
): string | null {
  const limpio = titulo?.trim();
  return limpio ? limpio.slice(0, LARGO_MAXIMO_TITULO) : null;
}

export function normalizarTipo(tipo: string | undefined | null): string {
  const limpio = tipo?.trim();
  return limpio ? limpio.slice(0, LARGO_MAXIMO_TIPO) : TIPO_SIN_DATO;
}
