import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { ETIQUETAS_CAMPOS } from '../validation/etiquetas-campos';

/**
 * Lo que lee la persona no lleva nombres del código: ni campos (`cashBoxId`,
 * `paid_at`), ni valores de enum (`with_customer`), ni `campo=false`. Este test
 * recorre el código y mira los textos de las excepciones y los errores de
 * dominio. Si falla: escribí el mensaje con el nombre que ve la persona
 * (`src/common/validation/etiquetas-campos.ts`) o, si es un valor de enum,
 * pasalo por `valorLegible(...)`.
 */

const RAIZ = join(__dirname, '..', '..');

/** Textos que, por un contrato con el panel o las apps, conservan el nombre interno. */
const PERMITIDOS: ReadonlyArray<{ contiene: string; motivo: string }> = [
  {
    contiene: 'scheduledAt: ',
    motivo:
      'FleetTaskFormModal del panel reconoce el prefijo «scheduledAt:» y lo quita antes de mostrar el texto',
  },
];

/**
 * Expresiones interpoladas que no son un valor de enum crudo: el nombre comercial de
 * un producto, un código HTTP o el motivo que ya arma otra capa en castellano.
 */
const INTERPOLACIONES_PERMITIDAS: readonly string[] = [
  'gasCylinder.type', // el tipo de garrafa es su nombre comercial («10kg»)
  'garrafa.type',
  'fila.type',
  'respuesta.status', // código HTTP de Mercado Pago, un número
  'fila?.reason', // motivo de geometría inválida, escrito en castellano por la validación de la zona
];

/** Una tabla de textos (`ETIQUETA_DEL_ESTADO[x.status]`) o un ternario entre textos ya traducen el valor. */
const TRADUCE_EL_VALOR = /^[A-Z][A-Z_]+\[|\?[^:]*'[^']*'\s*:/;

const CLASES_COMUNES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
]);

const IDENTIFICADOR =
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|=\s*(?:true|false)\b/;

const CAMPOS = new Set(Object.keys(ETIQUETAS_CAMPOS));

const EXPRESION_DE_ENUM =
  /(?:^|\.)(?:status|kind|category|state|method|reason|role|condition|mode|type)\b/;

function archivos(dir: string, salida: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) {
      if (nombre !== 'migrations') archivos(ruta, salida);
    } else if (ruta.endsWith('.ts') && !ruta.endsWith('.spec.ts')) {
      salida.push(ruta);
    }
  }
  return salida;
}

interface Literal {
  texto: string;
  interpolaciones: string[];
}

/** Los literales de texto de los argumentos de una llamada (desde el paréntesis ya abierto). */
function literalesDe(codigo: string, desde: number): Literal[] {
  const literales: Literal[] = [];
  let profundidad = 1;
  let i = desde;
  while (i < codigo.length && profundidad > 0) {
    const c = codigo[i];
    if (c === '(' || c === '{' || c === '[') profundidad++;
    else if (c === ')' || c === '}' || c === ']') profundidad--;
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let texto = '';
      const interpolaciones: string[] = [];
      while (j < codigo.length && codigo[j] !== c) {
        if (codigo[j] === '\\') {
          j += 2;
          continue;
        }
        if (c === '`' && codigo[j] === '$' && codigo[j + 1] === '{') {
          let n = 1;
          let k = j + 2;
          while (n > 0) {
            if (codigo[k] === '{') n++;
            if (codigo[k] === '}') n--;
            k++;
          }
          interpolaciones.push(codigo.slice(j + 2, k - 1).trim());
          texto += '¤';
          j = k;
          continue;
        }
        texto += codigo[j];
        j++;
      }
      literales.push({ texto, interpolaciones });
      i = j;
    }
    i++;
  }
  return literales;
}

/** Dónde termina la lista de argumentos de una llamada (desde el paréntesis ya abierto). */
function finDeArgumentos(codigo: string, desde: number): number {
  let profundidad = 1;
  let i = desde;
  while (i < codigo.length && profundidad > 0) {
    const c = codigo[i];
    if (c === '(' || c === '{' || c === '[') profundidad++;
    else if (c === ')' || c === '}' || c === ']') profundidad--;
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < codigo.length && codigo[j] !== c)
        j += codigo[j] === '\\' ? 2 : 1;
      i = j;
    }
    i++;
  }
  return i;
}

/** Constantes de texto del archivo (`const MENSAJE = '…'`): un mensaje guardado aparte también se revisa. */
function constantesDeTexto(codigo: string): Map<string, Literal> {
  const constantes = new Map<string, Literal>();
  const declaracion =
    /\bconst\s+([A-Z][A-Z0-9_]+)\s*(?::\s*string\s*)?=\s*(?=['"`])/g;
  for (let m = declaracion.exec(codigo); m; m = declaracion.exec(codigo)) {
    // literalesDe espera estar dentro de un paréntesis: se le da el literal solo.
    const [literal] = literalesDe(`${codigo.slice(m.index + m[0].length)})`, 0);
    if (literal) constantes.set(m[1], literal);
  }
  return constantes;
}

/** Un literal de mensaje que deja ver un nombre del código. */
function esMalo(lit: Literal): boolean {
  if (!/\s/.test(lit.texto)) return false;
  const sinCodigoEnLinea = lit.texto.replace(/`[^`]*`/g, '');
  const inicio = /^([a-z][A-Za-z0-9_]*): /.exec(lit.texto);
  const usaNombre =
    IDENTIFICADOR.test(sinCodigoEnLinea) ||
    (inicio !== null && CAMPOS.has(inicio[1]));
  // `${campo}: …`: el nombre del campo llega por parámetro y tiene que pasar por su etiqueta.
  // (Una constante en mayúsculas o un `contexto` ya armado en castellano no cuentan.)
  const campoPorParametro =
    lit.texto.startsWith('¤: ') &&
    /^(?:campo|field|key|clave|prop|propiedad)\b/.test(
      lit.interpolaciones[0] ?? '',
    );
  const enumCrudo = lit.interpolaciones.some(
    (e) =>
      EXPRESION_DE_ENUM.test(e) &&
      !/valorLegible|etiqueta/.test(e) &&
      !TRADUCE_EL_VALOR.test(e) &&
      !INTERPOLACIONES_PERMITIDAS.some((p) => e.includes(p)),
  );
  if (!usaNombre && !enumCrudo && !campoPorParametro) return false;
  return !PERMITIDOS.some((p) => lit.texto.includes(p.contiene));
}

/** Los mensajes con nombres del código de un archivo fuente. */
function problemasDe(codigo: string): string[] {
  const malos: string[] = [];
  const constantes = constantesDeTexto(codigo);
  const llamadas = /new\s+([A-Za-z]+(?:Exception|Error))\s*\(|\bconCodigo\(/g;
  for (let m = llamadas.exec(codigo); m; m = llamadas.exec(codigo)) {
    if (m[1] && CLASES_COMUNES.has(m[1])) continue;
    const desde = m.index + m[0].length;
    const argumentos = codigo.slice(desde, finDeArgumentos(codigo, desde));
    const usadas = [...argumentos.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)]
      .map(([nombre]) => constantes.get(nombre))
      .filter((l): l is Literal => l !== undefined);
    for (const lit of [...literalesDe(codigo, desde), ...usadas]) {
      if (esMalo(lit)) malos.push(lit.texto.slice(0, 140));
    }
  }
  return malos;
}

function hallazgos(): string[] {
  return archivos(RAIZ).flatMap((ruta) =>
    problemasDe(readFileSync(ruta, 'utf8')).map(
      (texto) => `${relative(RAIZ, ruta)}: ${texto}`,
    ),
  );
}

describe('los mensajes de error no nombran campos ni valores del código', () => {
  it('ninguna excepción o error de dominio los muestra', () => {
    expect(hallazgos()).toEqual([]);
  });

  it('el detector sabe lo que busca (si no, el test de arriba no prueba nada)', () => {
    const muestra = [
      'throw new BadRequestException("indicá cashBoxId para pagar");',
      'throw new BadRequestException("Caja: falta con_valor snake");',
      'throw new ConflictException(`Estado ${orden.status} no admite`);',
      'throw new BadRequestException("desactivalo (isActive=false) ya");',
      // El campo llega por parámetro, sin pasar por su etiqueta.
      'throw new BadRequestException(`${campo}: no puede ser una fecha futura`);',
      // El mensaje está guardado en una constante del archivo.
      "const MENSAJE_EGRESO = 'checkOutAt: el egreso va después';\nthrow new BadRequestException(MENSAJE_EGRESO);",
    ];
    expect(muestra.filter((codigo) => problemasDe(codigo).length > 0)).toEqual(
      muestra,
    );
    const bien = [
      'throw new BadRequestException(`${rutaLegible(campo.split(".")) }: no puede ser futura`);',
      "const MENSAJE = 'Hora de salida: tiene que ser posterior al ingreso';\nthrow new BadRequestException(MENSAJE);",
    ];
    expect(bien.filter((codigo) => problemasDe(codigo).length > 0)).toEqual([]);
  });

  it('lo permitido por contrato con el panel o las apps tiene su motivo anotado', () => {
    expect(PERMITIDOS.every((p) => p.motivo.length > 20)).toBe(true);
  });
});
