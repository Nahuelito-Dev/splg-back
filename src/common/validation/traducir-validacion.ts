import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { etiquetaDeCampo, etiquetaDeValor, rutaLegible } from './etiquetas';

/**
 * Traductor de los mensajes por omisión de class-validator.
 *
 * Se trabaja sobre el árbol de `ValidationError` (clave de la restricción +
 * propiedad + ruta) y no sobre el texto ya aplanado por Nest: así el nombre del
 * campo sale completo (`items.0.quantity`) y un mensaje propio del DTO, que ya
 * viene en castellano, pasa intacto. Un mensaje se considera «por omisión»
 * cuando arranca con el nombre de la propiedad y encaja con la plantilla en
 * inglés de su restricción; lo que no encaja es un mensaje propio.
 */

interface Contexto {
  /** Propiedad que falló, tal como se llama en el código (para elegir etiquetas de valores). */
  readonly campo: string;
}

type Traduccion = (m: RegExpMatchArray, ctx: Contexto) => string;

interface Regla {
  /** Cola del mensaje en inglés, sin el nombre de la propiedad. */
  readonly en: RegExp;
  readonly es: Traduccion;
}

const fija =
  (texto: string): Traduccion =>
  () =>
    texto;

/** «1 elemento», «3 elementos». */
const cuantos = (n: string, uno: string, varios: string): string =>
  `${n} ${n === '1' ? uno : varios}`;

const regla = (en: RegExp, es: Traduccion | string): Regla => ({
  en,
  es: typeof es === 'string' ? fija(es) : es,
});

/** «al día, por vencer, vencida o falta cargar»: los valores con su texto; sin texto, no se enumera. */
function enumerar(lista: string, ctx: Contexto): string | null {
  const textos = lista.split(', ').map((v) => etiquetaDeValor(v, ctx.campo));
  if (textos.some((t) => t === undefined)) return null;
  const t = textos as string[];
  return t.length === 1
    ? t[0]
    : `${t.slice(0, -1).join(', ')} o ${t[t.length - 1]}`;
}

function opciones(lista: string, ctx: Contexto): string {
  const enumerado = enumerar(lista, ctx);
  return enumerado === null
    ? 'elegí una de las opciones disponibles'
    : `elegí una opción válida (${enumerado})`;
}

/** Cuando la lista trae varias opciones («cada opción tiene que ser una de: …»). */
function opcionesDeCadaUna(lista: string, ctx: Contexto): string {
  const enumerado = enumerar(lista, ctx);
  return enumerado === null
    ? 'cada opción tiene que ser una de las disponibles'
    : `cada opción tiene que ser una de: ${enumerado}`;
}

const NO_ES_OPCION = (lista: string, ctx: Contexto): string => {
  const textos = lista.split(', ').map((v) => etiquetaDeValor(v, ctx.campo));
  if (textos.some((t) => t === undefined))
    return 'tiene un valor que no se admite';
  return `no puede ser ${(textos as string[]).join(', ')}`;
};

/** `key` de la restricción de class-validator → plantilla en inglés y su versión. */
const REGLAS: Readonly<Record<string, Regla>> = {
  isString: regla(/^must be a string$/, 'tiene que ser un texto'),
  isInt: regla(/^must be an integer number$/, 'tiene que ser un número entero'),
  isNumber: regla(
    /^must be a number conforming to the specified constraints$/,
    'tiene que ser un número válido (revisá la cantidad de decimales)',
  ),
  isBoolean: regla(
    /^must be a boolean value$/,
    'tiene que ser verdadero o falso',
  ),
  isUuid: regla(/^must be a UUID$/, 'no es válido'),
  isEnum: regla(/^must be one of the following values: (.*)$/s, (m, c) =>
    opciones(m[1], c),
  ),
  isIn: regla(/^must be one of the following values: (.*)$/s, (m, c) =>
    opciones(m[1], c),
  ),
  isNotIn: regla(/^should not be one of the following values: (.*)$/s, (m, c) =>
    NO_ES_OPCION(m[1], c),
  ),
  isNotEmpty: regla(/^should not be empty$/, 'no puede estar vacío'),
  isDefined: regla(/^should not be null or undefined$/, 'es obligatorio'),
  isArray: regla(/^must be an array$/, 'tiene que ser una lista'),
  isObject: regla(/^must be an object$/, 'tiene que ser un objeto'),
  isNotEmptyObject: regla(
    /^must be a non-empty object$/,
    'no puede ser un objeto vacío',
  ),
  isEmail: regla(
    /^must be an email$/,
    'tiene que ser un correo electrónico válido',
  ),
  isIso8601: regla(
    /^must be a valid ISO 8601 date string$/,
    'tiene que ser una fecha válida',
  ),
  isDateString: regla(
    /^must be a valid ISO 8601 date string$/,
    'tiene que ser una fecha válida (formato ISO 8601)',
  ),
  isDate: regla(/^must be a Date instance$/, 'tiene que ser una fecha válida'),
  isPositive: regla(
    /^must be a positive number$/,
    'tiene que ser un número positivo',
  ),
  isNegative: regla(
    /^must be a negative number$/,
    'tiene que ser un número negativo',
  ),
  min: regla(
    /^must not be less than (.*)$/,
    (m) => `tiene que ser como mínimo ${m[1]}`,
  ),
  max: regla(
    /^must not be greater than (.*)$/,
    (m) => `tiene que ser como máximo ${m[1]}`,
  ),
  minLength: regla(
    /^must be longer than or equal to (\d+) characters$/,
    (m) =>
      `tiene que tener al menos ${cuantos(m[1], 'carácter', 'caracteres')}`,
  ),
  maxLength: regla(
    /^must be shorter than or equal to (\d+) characters$/,
    (m) =>
      `tiene que tener como máximo ${cuantos(m[1], 'carácter', 'caracteres')}`,
  ),
  isLength: regla(
    /^must be longer than or equal to (\d+) and shorter than or equal to (\d+) characters$/,
    (m) => `tiene que tener entre ${m[1]} y ${m[2]} caracteres`,
  ),
  arrayMinSize: regla(
    /^must contain at least (\d+) elements$/,
    (m) => `tiene que tener al menos ${cuantos(m[1], 'elemento', 'elementos')}`,
  ),
  arrayMaxSize: regla(
    /^must contain no more than (\d+) elements$/,
    (m) => `no puede tener más de ${cuantos(m[1], 'elemento', 'elementos')}`,
  ),
  arrayNotEmpty: regla(/^should not be empty$/, 'no puede estar vacío'),
  matches: regla(
    /^must match .* regular expression$/s,
    'no tiene un formato válido',
  ),
  isLatLong: regla(
    /^must be a latitude,longitude string$/,
    'tiene que ser una coordenada «latitud,longitud» válida',
  ),
  isLatitude: regla(
    /^must be a latitude string or number$/,
    'tiene que ser una latitud válida',
  ),
  isLongitude: regla(
    /^must be a longitude string or number$/,
    'tiene que ser una longitud válida',
  ),
  isPhoneNumber: regla(
    /^must be a valid phone number$/,
    'tiene que ser un teléfono válido',
  ),
  isUrl: regla(
    /^must be a URL address$/,
    'tiene que ser una dirección web válida',
  ),
  isMilitaryTime: regla(
    /^must be a valid representation of military time in the format HH:MM$/,
    'tiene que ser una hora válida con formato HH:MM',
  ),
  isTimeZone: regla(
    /^must be a valid IANA time-zone$/,
    'tiene que ser una zona horaria válida',
  ),
  isDivisibleBy: regla(
    /^must be divisible by (.*)$/,
    (m) => `tiene que ser múltiplo de ${m[1]}`,
  ),
  equals: regla(
    /^must be equal to (.*)$/,
    (m) => `tiene que ser igual a ${m[1]}`,
  ),
  isEmpty: regla(/^must be empty$/, 'tiene que estar vacío'),
  isJson: regla(/^must be a json string$/, 'tiene que ser un JSON válido'),
  isLowercase: regla(
    /^must be a lowercase string$/,
    'tiene que estar en minúsculas',
  ),
  isUppercase: regla(/^must be uppercase$/, 'tiene que estar en mayúsculas'),
  isNumberString: regla(
    /^must be a number string$/,
    'tiene que ser un número escrito como texto',
  ),
  isBooleanString: regla(
    /^must be a boolean string$/,
    'tiene que ser verdadero o falso',
  ),
};

/** Mensaje de NESTED_VALIDATION: no arranca con el nombre de la propiedad. */
const NESTED =
  /^(each value in )?nested property .* must be either object or array$/s;

/** Mensaje de ARRAY_UNIQUE: arranca con «All», no con el nombre de la propiedad. */
const ARRAY_UNIQUE = /^All (.*)'s elements must be unique$/s;

const PREFIJO_EACH = 'each value in ';
const CADA_UNO = 'cada elemento ';

/** Mensaje de la propiedad no declarada en el DTO (`forbidNonWhitelisted`). */
export function mensajeCampoNoPermitido(campo: string, clase?: string): string {
  const etiqueta = etiquetaDeCampo(campo, clase);
  return etiqueta
    ? `Se envió un dato que no corresponde: ${etiqueta}`
    : 'Se envió un dato que no corresponde';
}

function pareceInglesPorOmision(texto: string, propiedad: string): boolean {
  return (
    texto.startsWith(`${propiedad} `) &&
    /^(must|should|'s)\b/.test(texto.slice(propiedad.length + 1))
  );
}

/** Un campo sin etiqueta no muestra su nombre interno. */
const SIN_ETIQUETA = 'Dato';

interface Lugar {
  readonly propiedad: string;
  /** Etiqueta del campo (con sus padres: «Renglón 2 · Cantidad»). */
  readonly etiqueta: string;
  /** DTO que recibe el cuerpo, si el campo es de primer nivel (para etiquetas por clase). */
  readonly clase?: string;
  /** Etiqueta de los padres, con su separador: «Renglón 2 · » o vacío. */
  readonly padres: string;
}

function traducirRestriccion(
  clave: string,
  texto: string,
  lugar: Lugar,
): string {
  const { propiedad, etiqueta } = lugar;
  const ctx: Contexto = { campo: propiedad };

  if (clave === 'whitelistValidation') {
    return texto === `property ${propiedad} should not exist`
      ? `${lugar.padres}${mensajeCampoNoPermitido(propiedad, lugar.clase)}`
      : propio(texto, lugar);
  }
  if (clave === 'arrayUnique' && ARRAY_UNIQUE.test(texto)) {
    return `${etiqueta}: no puede tener elementos repetidos`;
  }
  if (clave === 'nestedValidation' && NESTED.test(texto)) {
    return texto.startsWith(PREFIJO_EACH)
      ? `${etiqueta}: tiene que ser una lista válida`
      : `${etiqueta}: tiene que ser un objeto`;
  }

  let cuerpo = texto;
  let cadaUno = false;
  if (cuerpo.startsWith(PREFIJO_EACH)) {
    cuerpo = cuerpo.slice(PREFIJO_EACH.length);
    cadaUno = true;
  }
  if (!cuerpo.startsWith(`${propiedad} `)) return propio(texto, lugar);
  const cola = cuerpo.slice(propiedad.length + 1);

  // `@Length` avisa sólo el límite que se rompió: comparte las plantillas de MinLength/MaxLength.
  const candidatas = (
    clave === 'isLength' ? ['isLength', 'minLength', 'maxLength'] : [clave]
  )
    .map((k) => (Object.hasOwn(REGLAS, k) ? REGLAS[k] : undefined))
    .filter((r): r is Regla => r !== undefined);
  for (const candidata of candidatas) {
    const m = cola.match(candidata.en);
    if (m) {
      if (cadaUno && (clave === 'isEnum' || clave === 'isIn')) {
        return `${etiqueta}: ${opcionesDeCadaUna(m[1], ctx)}`;
      }
      return `${etiqueta}: ${cadaUno ? CADA_UNO : ''}${candidata.es(m, ctx)}`;
    }
  }
  // Plantilla en inglés de una restricción que no conocemos: nunca sale en inglés.
  if (pareceInglesPorOmision(cuerpo, propiedad) && candidatas.length === 0) {
    return `${etiqueta}: ${cadaUno ? CADA_UNO : ''}tiene un valor inválido`;
  }
  return propio(texto, lugar);
}

const NOMBRE_AL_PRINCIPIO = /^([A-Za-z][A-Za-z0-9_]*)(?::\s*|\s+)(.*)$/s;

/**
 * Mensaje propio del DTO (ya en castellano). Si arranca con el nombre de un
 * campo del código se cambia por su etiqueta: «bankCbu tiene que tener 22
 * dígitos» → «CBU bancario: tiene que tener 22 dígitos».
 */
function propio(texto: string, lugar: Lugar): string {
  const m = texto.match(NOMBRE_AL_PRINCIPIO);
  const etiqueta = m ? etiquetaDeCampo(m[1], lugar.clase) : undefined;
  if (m && etiqueta) {
    // El mismo campo del que se habla: su etiqueta completa (con padres).
    const propia =
      m[1] === lugar.propiedad ? lugar.etiqueta : `${lugar.padres}${etiqueta}`;
    return `${propia}: ${m[2]}`;
  }
  // «tiene que ser…» sin nombre: la etiqueta del campo va adelante.
  if (/^\p{Ll}/u.test(texto)) return `${lugar.etiqueta}: ${texto}`;
  return `${lugar.padres}${texto}`;
}

/**
 * Traduce un mensaje por omisión ya aplanado («term must be shorter than or
 * equal to 254 characters»), sin conocer la restricción: prueba todas las
 * plantillas. Sirve para texto suelto (p. ej. ejemplos guardados); en el
 * flujo normal se usa `traducirErrores`, que sabe qué restricción falló.
 */
export function traducirMensajeSuelto(texto: string): string | null {
  const m = texto.match(/^(?:each value in )?([A-Za-z0-9_]+) (.*)$/s);
  if (!m) return null;
  const [, propiedad, cola] = m;
  const etiqueta = etiquetaDeCampo(propiedad) ?? SIN_ETIQUETA;
  const cada = texto.startsWith(PREFIJO_EACH) ? CADA_UNO : '';
  for (const regla of Object.values(REGLAS)) {
    const r = cola.match(regla.en);
    if (r) return `${etiqueta}: ${cada}${regla.es(r, { campo: propiedad })}`;
  }
  return null;
}

interface Plano {
  readonly error: ValidationError;
  readonly ruta: readonly string[];
}

/**
 * Mismo aplanado que `ValidationPipe` de Nest: de un error con hijos sólo salen
 * los de los hijos (los hijos con hijos primero, y después sus propias
 * restricciones); un error sin hijos sale tal cual.
 */
function aplanar(
  error: ValidationError,
  padre: readonly string[] | undefined,
): Plano[] {
  if (!error.children?.length) return [{ error, ruta: [error.property] }];
  const ruta = padre ? [...padre, error.property] : [error.property];
  const salida: Plano[] = [];
  for (const hijo of error.children) {
    if (hijo.children?.length) salida.push(...aplanar(hijo, ruta));
    salida.push({ error: hijo, ruta: [...ruta, hijo.property] });
  }
  return salida;
}

function claseDe(error: ValidationError): string | undefined {
  const target: unknown = error.target;
  return typeof target === 'object' && target !== null
    ? target.constructor.name
    : undefined;
}

/** Aplana y traduce los errores de class-validator. Mismo orden que Nest. */
export function traducirErrores(errores: readonly ValidationError[]): string[] {
  const salida: string[] = [];
  for (const raiz of errores) {
    const clase = claseDe(raiz);
    for (const { error, ruta } of aplanar(raiz, undefined)) {
      if (!error.constraints) continue;
      const etiqueta = rutaLegible(ruta, clase) || SIN_ETIQUETA;
      const padres =
        ruta.length > 1 ? rutaLegible(ruta.slice(0, -1), clase) : '';
      const lugar: Lugar = {
        propiedad: error.property,
        etiqueta,
        clase: ruta.length === 1 ? clase : undefined,
        padres: padres ? `${padres} · ` : '',
      };
      for (const [clave, texto] of Object.entries(error.constraints)) {
        salida.push(traducirRestriccion(clave, texto, lugar));
      }
    }
  }
  return salida;
}

/** `exceptionFactory` del ValidationPipe: mismo 400 `{statusCode, message[], error}`. */
export function fabricarExcepcionDeValidacion(
  errores: ValidationError[] = [],
): BadRequestException {
  return new BadRequestException(traducirErrores(errores));
}
