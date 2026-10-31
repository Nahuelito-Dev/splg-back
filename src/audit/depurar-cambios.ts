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
export function depurarCambios(cuerpo: unknown): CambiosAuditados | null {
  if (!esObjeto(cuerpo) || Object.keys(cuerpo).length === 0) return null;
  return depurarObjeto(cuerpo, 0);
}

function depurarObjeto(
  objeto: Record<string, unknown>,
  profundidad: number,
): CambiosAuditados {
  const limpio: CambiosAuditados = {};
  for (const [clave, valor] of Object.entries(objeto)) {
    limpio[clave] = SENSIBLES.has(clave.toLowerCase())
      ? '[depurado]'
      : depurarValor(valor, profundidad + 1);
  }
  return limpio;
}

function depurarValor(valor: unknown, profundidad: number): unknown {
  if (typeof valor === 'string') {
    return valor.length > LARGO_MAXIMO
      ? `${valor.slice(0, LARGO_MAXIMO)}…`
      : valor;
  }
  if (profundidad > PROFUNDIDAD_MAXIMA) return '[recortado]';
  if (Array.isArray(valor)) {
    return valor.map((v) => depurarValor(v, profundidad + 1));
  }
  if (esObjeto(valor)) return depurarObjeto(valor, profundidad);
  return valor;
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}
