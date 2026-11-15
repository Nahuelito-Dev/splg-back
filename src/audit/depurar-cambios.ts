import type { CambiosAuditados } from './entities/audit-log.entity';

/**
 * Claves que nunca se guardan en la auditoría (CU-153: "las credenciales nunca
 * se guardan"). Se comparan sin distinguir mayúsculas y en cualquier nivel del
 * cuerpo. `code` es el código secreto de entrega del QR; `details` es el
 * detalle de la documentación del personal (resultado del psicofísico, póliza
 * de la ART, certificados): datos personales (Ley 25.326).
 */
const SENSIBLES = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'token',
  'idtoken',
  'accesstoken',
  'refreshtoken',
  'notification_token',
  'notificationtoken',
  'code',
  'deliverycode',
  'secret',
  // Secreto con el que Mercado Pago firma los avisos de una cuenta propia
  // (credenciales por distribuidora): en la auditoría HTTP, inmutable, no entra.
  'webhooksecret',
  // Datos de quien recibe un pedido (CU-128): de un tercero y en un registro
  // inmutable, que no puede acompañar la anulación por plazo vencido.
  'receiverdocument',
  'receivername',
  'receiverrelationship',
  // Detalle de la documentación del personal (psicofísico, ART).
  'details',
]);

const LARGO_MAXIMO = 500;
const PROFUNDIDAD_MAXIMA = 4;

/**
 * El cuerpo de la operación, listo para guardar: sin credenciales, con los
 * textos largos recortados y sin anidar más de cuatro niveles. `null` si no
 * hay cuerpo.
 */
export function depurarCambios(
  cuerpo: unknown,
  ruta?: string,
): CambiosAuditados | null {
  if (!esObjeto(cuerpo) || Object.keys(cuerpo).length === 0) return null;
  const extra =
    ruta !== undefined && RUTAS_DE_MENSAJES.test(ruta)
      ? TEXTO_DE_LOS_MENSAJES
      : SIN_EXTRA;
  return depurarObjeto(cuerpo, 0, extra);
}

/**
 * Rutas de la mensajería (chat con la plataforma y tickets): el texto de los
 * mensajes no entra a la bitácora, que es inmutable (D-C11, §10.3): no se
 * podría cumplir la retención. Queda que se escribió, quién y dónde.
 */
const RUTAS_DE_MENSAJES =
  /\/(company\/platform-chat|company\/tickets|platform\/chats|platform\/tickets)(\/|$)/;
const TEXTO_DE_LOS_MENSAJES: ReadonlySet<string> = new Set([
  'body',
  'note',
  'caption',
  'subject',
]);
const SIN_EXTRA: ReadonlySet<string> = new Set();

function depurarObjeto(
  objeto: Record<string, unknown>,
  profundidad: number,
  extra: ReadonlySet<string> = SIN_EXTRA,
): CambiosAuditados {
  const limpio: CambiosAuditados = {};
  for (const [clave, valor] of Object.entries(objeto)) {
    const minuscula = clave.toLowerCase();
    limpio[clave] =
      SENSIBLES.has(minuscula) || extra.has(minuscula)
        ? '[depurado]'
        : depurarValor(valor, profundidad + 1, extra);
  }
  return limpio;
}

function depurarValor(
  valor: unknown,
  profundidad: number,
  extra: ReadonlySet<string>,
): unknown {
  if (typeof valor === 'string') {
    return valor.length > LARGO_MAXIMO
      ? `${valor.slice(0, LARGO_MAXIMO)}…`
      : valor;
  }
  if (profundidad > PROFUNDIDAD_MAXIMA) return '[recortado]';
  if (Array.isArray(valor)) {
    return valor.map((v) => depurarValor(v, profundidad + 1, extra));
  }
  if (esObjeto(valor)) return depurarObjeto(valor, profundidad, extra);
  return valor;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}
