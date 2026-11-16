import { STATUS_CODES } from 'http';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Textos en inglés que arma el propio Nest o Express (Parse*Pipe, 404 de ruta
 * inexistente, throttler, multer, body-parser, el 500 genérico y el campo
 * `error` de cada status) pasados a castellano. Se aplica en
 * el filtro global, así vale para todos los usos sin tocar cada controller.
 * Status y forma de la respuesta (`{statusCode, message, error}`) no cambian.
 */

/** Campo `error` de la respuesta, por código de estado (todos los 4xx y 5xx de http). */
const ERROR_POR_ESTADO: Readonly<Record<number, string>> = {
  400: 'Solicitud inválida',
  401: 'No autenticado',
  402: 'Pago requerido',
  403: 'Acceso denegado',
  404: 'No encontrado',
  405: 'Método no permitido',
  406: 'No aceptable',
  407: 'Autenticación de proxy requerida',
  408: 'Tiempo de espera agotado',
  409: 'Conflicto',
  410: 'Ya no está disponible',
  411: 'Falta la longitud del contenido',
  412: 'Precondición fallida',
  413: 'Archivo demasiado grande',
  414: 'Dirección demasiado larga',
  415: 'Tipo de contenido no admitido',
  416: 'Rango no satisfactorio',
  417: 'Expectativa fallida',
  418: 'Soy una tetera',
  421: 'Solicitud mal dirigida',
  422: 'No se puede procesar',
  423: 'Recurso bloqueado',
  424: 'Dependencia fallida',
  425: 'Demasiado temprano',
  426: 'Se requiere actualizar el protocolo',
  428: 'Precondición requerida',
  429: 'Demasiadas solicitudes',
  431: 'Encabezados demasiado grandes',
  451: 'No disponible por razones legales',
  500: 'Error interno del servidor',
  501: 'No implementado',
  502: 'Respuesta inválida del servicio externo',
  503: 'Servicio no disponible',
  504: 'El servicio externo no respondió a tiempo',
  505: 'Versión de HTTP no admitida',
  506: 'La negociación de contenido falló',
  507: 'Almacenamiento insuficiente',
  508: 'Se detectó un bucle',
  510: 'Faltan extensiones',
  511: 'Autenticación de red requerida',
};

function errorDe(status: number): string {
  return ERROR_POR_ESTADO[status] ?? 'Error';
}

/** Los nombres en inglés de cada status; es lo que Nest pone por omisión en `error` y en `message`. */
const NOMBRES_EN_INGLES: ReadonlySet<string> = new Set(
  Object.entries(STATUS_CODES)
    .filter(([codigo]) => Number(codigo) >= 400)
    .map(([, nombre]) => nombre as string),
);

/** Mensajes fijos que arman Nest, el throttler y multer. */
const MENSAJES_FIJOS: Readonly<Record<string, string>> = {
  'Internal server error': 'Error interno del servidor',
  'ThrottlerException: Too Many Requests':
    'Demasiadas solicitudes: probá de nuevo en unos instantes',
  'Forbidden resource': 'No tenés permiso para acceder a este recurso',
  'File too large': 'El archivo es demasiado grande',
  'Too many files': 'Hay más archivos de los permitidos',
  'Too many parts': 'La solicitud trae demasiadas partes',
  'Too many fields': 'La solicitud trae demasiados campos',
  'Field name too long': 'El nombre de un campo es demasiado largo',
  'Field value too long': 'El valor de un campo es demasiado largo',
  'Field name missing': 'Falta el nombre de un campo',
  'Multipart: Boundary not found': 'La solicitud multipart no es válida',
  'Multipart: Malformed part header': 'La solicitud multipart no es válida',
  'Multipart: Unexpected end of form': 'La solicitud multipart está incompleta',
  'Multipart: Unexpected end of file': 'La solicitud multipart está incompleta',
  'Unexpected field': 'Campo de archivo inesperado',
  'File is required': 'Falta el archivo',
};

/** Mensaje por `type` de los errores de body-parser / raw-body / http-errors. */
const MENSAJE_POR_TIPO: Readonly<Record<string, string>> = {
  'entity.parse.failed': 'El cuerpo de la solicitud no es un JSON válido',
  'entity.too.large': 'El cuerpo de la solicitud es demasiado grande',
  'charset.unsupported':
    'La codificación de caracteres de la solicitud no se admite',
  'encoding.unsupported': 'La compresión de la solicitud no se admite',
  'request.aborted': 'La solicitud se interrumpió antes de terminar',
  'request.size.invalid':
    'El tamaño de la solicitud no coincide con lo enviado',
  'parameters.too.many': 'La solicitud trae demasiados parámetros',
  'stream.encoding.set': 'La solicitud no se pudo leer',
};

/**
 * Lo que dice `JSON.parse` (según la versión de Node) cuando el cuerpo no es un
 * JSON. Nest convierte ese `SyntaxError` en un `BadRequestException(err.message)`
 * y se pierde el `type` de body-parser, así que sólo queda el texto.
 */
const JSON_ROTO =
  /in JSON at position|^Unexpected (token|end of JSON)|^Expected (property name|double-quoted|',' or)|is not valid JSON|^Bad control character/;

const CAMPO_INESPERADO = /^Unexpected field - (.+)$/s;
const PIPE_DE_PARAMETRO = /^Validation failed \((.*)\)$/s;
const RUTA_INEXISTENTE =
  /^Cannot (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) (.+)$/s;

/** Código estable (en inglés) que acompaña el 400 de un identificador mal formado. */
export const CODIGO_ID_INVALIDO = 'INVALID_ID';

function mensajeDePipe(detalle: string): string {
  if (/^uuid/.test(detalle)) return 'El identificador no es válido';
  if (/^numeric string/.test(detalle))
    return 'El valor tiene que ser un número';
  if (/^boolean string/.test(detalle)) {
    return 'El valor tiene que ser verdadero o falso';
  }
  if (/^enum string/.test(detalle))
    return 'El valor no es uno de los permitidos';
  if (/^(array|date) string/.test(detalle)) return 'El valor no es válido';
  return 'El valor recibido no es válido';
}

interface Traducido {
  readonly message: string;
  readonly code?: string;
}

function traducirTexto(
  texto: string,
  status: number,
  porOmision: boolean,
): Traducido | null {
  const pipe = texto.match(PIPE_DE_PARAMETRO);
  if (pipe) {
    return {
      message: mensajeDePipe(pipe[1]),
      ...(/^uuid/.test(pipe[1]) ? { code: CODIGO_ID_INVALIDO } : {}),
    };
  }
  const ruta = texto.match(RUTA_INEXISTENTE);
  if (ruta) return { message: `No existe la ruta ${ruta[1]} ${ruta[2]}` };
  if (status === 400 && porOmision && JSON_ROTO.test(texto)) {
    return { message: MENSAJE_POR_TIPO['entity.parse.failed'] };
  }
  const campo = texto.match(CAMPO_INESPERADO);
  if (campo) return { message: `Campo de archivo inesperado: ${campo[1]}` };
  if (Object.hasOwn(MENSAJES_FIJOS, texto)) {
    return { message: MENSAJES_FIJOS[texto] };
  }
  if (NOMBRES_EN_INGLES.has(texto)) return { message: errorDe(status) };
  return null;
}

interface ErrorDeHttp {
  statusCode?: unknown;
  status?: unknown;
  type?: unknown;
  expose?: unknown;
}

function respuesta(status: number, message: string): HttpException {
  return new HttpException(
    { statusCode: status, message, error: errorDe(status) },
    status,
  );
}

/** Status de un error de http-errors (body-parser y compañía), si lo trae. */
function estadoDeErrorCrudo(e: ErrorDeHttp): number | null {
  // Sólo los errores de body-parser / raw-body / http-errors: traen un `type`
  // conocido o `expose: true`. Un objeto cualquiera con `status` (el error de un
  // SDK de pagos, por ejemplo) es una falla nuestra, no un 4xx del cliente.
  const esDeHttp =
    e.expose === true ||
    (typeof e.type === 'string' && Object.hasOwn(MENSAJE_POR_TIPO, e.type));
  if (!esDeHttp) return null;
  const candidato = [e.statusCode, e.status].find(
    (s): s is number => typeof s === 'number' && s >= 400 && s <= 599,
  );
  return candidato ?? null;
}

/**
 * Errores que no son de Nest: los de body-parser/http-errors conservan su
 * status (con mensaje por tipo, o el genérico del status); cualquier otro
 * fallo sale como 500 genérico.
 */
function desdeErrorCrudo(exception: unknown): HttpException {
  const e = (
    typeof exception === 'object' && exception !== null ? exception : {}
  ) as ErrorDeHttp;
  const status = estadoDeErrorCrudo(e);
  if (status === null || status >= 500) {
    return respuesta(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'Error interno del servidor',
    );
  }
  const porTipo =
    typeof e.type === 'string' && Object.hasOwn(MENSAJE_POR_TIPO, e.type)
      ? MENSAJE_POR_TIPO[e.type]
      : undefined;
  return respuesta(status, porTipo ?? errorDe(status));
}

/** Devuelve la excepción con mensaje y `error` en castellano. */
export function traducirExcepcion(exception: unknown): HttpException {
  if (!(exception instanceof HttpException)) return desdeErrorCrudo(exception);
  const status = exception.getStatus();
  const cuerpo = exception.getResponse();

  if (typeof cuerpo === 'string') {
    // Un cuerpo de texto (HttpException('…'), el throttler) sale con la misma
    // forma que el resto: { statusCode, message, error }.
    const es = traducirTexto(cuerpo, status, false);
    return respuesta(status, es === null ? cuerpo : es.message);
  }
  if (typeof cuerpo !== 'object' || cuerpo === null) return exception;

  const actual = cuerpo as { message?: unknown; error?: unknown };
  let codigo: string | undefined;
  let mensaje = actual.message;
  if (typeof mensaje === 'string') {
    const es = traducirTexto(
      mensaje,
      status,
      actual.error === STATUS_CODES[status],
    );
    if (es) {
      mensaje = es.message;
      codigo = es.code;
    }
  }
  // Un `error` propio no se pisa: sólo el nombre en inglés del status por omisión.
  const error =
    typeof actual.error === 'string' && actual.error === STATUS_CODES[status]
      ? errorDe(status)
      : actual.error;
  const igual =
    error === actual.error &&
    (mensaje === actual.message ||
      (Array.isArray(mensaje) &&
        Array.isArray(actual.message) &&
        mensaje.every((m, i) => m === (actual.message as unknown[])[i])));
  if (igual && codigo === undefined) return exception;
  return new HttpException(
    { ...cuerpo, message: mensaje, error, ...(codigo ? { code: codigo } : {}) },
    status,
  );
}
