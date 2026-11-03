import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { CATALOGO, ProcessName } from './domain/process-catalog';

const RAIZ = join(__dirname, '..');

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivos(ruta);
    return ruta.endsWith('.ts') && !ruta.endsWith('.spec.ts') ? [ruta] : [];
  });
}

interface CronEncontrado {
  archivo: string;
  /** Lo que se le pasó a `@Cron(...)` como primer argumento, tal cual está escrito. */
  expresion: string;
  proceso: string | null;
}

/** Del `(` que abre en `desde`, el texto de adentro y la posición del `)` que lo cierra. */
function argumentos(
  texto: string,
  desde: number,
): { dentro: string; fin: number } {
  let profundidad = 0;
  for (let i = desde; i < texto.length; i++) {
    if (texto[i] === '(') profundidad += 1;
    if (texto[i] === ')') {
      profundidad -= 1;
      if (profundidad === 0)
        return { dentro: texto.slice(desde + 1, i), fin: i };
    }
  }
  throw new Error('paréntesis sin cerrar');
}

/** El primer argumento de `@Cron(...)`: un literal o `CronExpression.X`. */
function primerArgumento(dentro: string): string {
  const literal = /^\s*(['"`])([^'"`]+)\1/.exec(dentro);
  if (literal) return literal[2];
  const constante = /^\s*(CronExpression\.\w+)/.exec(dentro);
  return constante ? constante[1] : dentro.trim();
}

/**
 * Cada `@Cron(...)` con el `@ConRegistro(ProcessName.X)` de su bloque de
 * decoradores, esté arriba o abajo y con cualquier argumento.
 */
function cronsDe(texto: string, archivo: string): CronEncontrado[] {
  const encontrados: CronEncontrado[] = [];
  const registro = /^\s*@ConRegistro\(ProcessName\.(\w+)\)/;
  {
    for (const m of texto.matchAll(/@Cron\(/g)) {
      // Una mención dentro de un comentario no es un decorador.
      const linea = texto
        .slice(texto.lastIndexOf('\n', m.index) + 1, m.index)
        .trim();
      if (
        linea.startsWith('*') ||
        linea.startsWith('//') ||
        linea.startsWith('/*')
      )
        continue;
      const abre = m.index + '@Cron'.length;
      const { dentro, fin } = argumentos(texto, abre);
      let proceso: string | null = null;
      // Decoradores que siguen: comentarios y `@algo(...)` hasta la firma del método.
      let resto = texto.slice(fin + 1);
      for (;;) {
        resto = resto.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
        if (!resto.startsWith('@')) break;
        const hallado = registro.exec(resto);
        if (hallado) proceso = hallado[1];
        const nombre = /^@\w+/.exec(resto)?.[0] ?? '@';
        const { fin: cierra } = argumentos(resto, nombre.length);
        resto = resto.slice(cierra + 1);
      }
      // Decorador `@ConRegistro` escrito arriba del `@Cron`.
      const antes = /@ConRegistro\(ProcessName\.(\w+)\)\s*$/.exec(
        texto.slice(0, m.index),
      );
      if (!proceso && antes) proceso = antes[1];
      encontrados.push({
        archivo,
        expresion: primerArgumento(dentro),
        proceso,
      });
    }
  }
  return encontrados;
}

function crons(): CronEncontrado[] {
  return archivos(RAIZ).flatMap((archivo) =>
    cronsDe(readFileSync(archivo, 'utf8'), archivo.replace(RAIZ, 'src')),
  );
}

const CRON_EXPRESSION: Record<string, string> = {
  'CronExpression.EVERY_SECOND': '* * * * * *',
  'CronExpression.EVERY_5_SECONDS': '*/5 * * * * *',
  'CronExpression.EVERY_10_SECONDS': '*/10 * * * * *',
  'CronExpression.EVERY_30_SECONDS': '*/30 * * * * *',
  'CronExpression.EVERY_MINUTE': '0 * * * * *',
  'CronExpression.EVERY_5_MINUTES': '0 */5 * * * *',
  'CronExpression.EVERY_10_MINUTES': '0 */10 * * * *',
  'CronExpression.EVERY_30_MINUTES': '0 */30 * * * *',
  'CronExpression.EVERY_HOUR': '0 * * * *',
  'CronExpression.EVERY_DAY_AT_MIDNIGHT': '0 0 * * *',
};

/** Cada cuántos segundos dispara una expresión de cron (5 o 6 campos), por su campo repetitivo más fino. */
function periodoDeCron(expresion: string): number {
  const campos = expresion.trim().split(/\s+/);
  const [seg, min, hora] = campos.length === 5 ? ['0', ...campos] : campos;
  const paso = (campo: string): number | 'fijo' | 'todos' => {
    if (campo === '*') return 'todos';
    const cada = /^\*\/(\d+)$/.exec(campo);
    if (cada) return Number(cada[1]);
    if (campo.includes(',')) return 60 / campo.split(',').length;
    return 'fijo';
  };
  const unidades: Array<[string, number]> = [
    [seg, 1],
    [min, 60],
    [hora, 3600],
  ];
  for (const [campo, unidad] of unidades) {
    const p = paso(campo);
    if (p === 'todos') return unidad;
    if (p !== 'fijo') return p * unidad;
  }
  return 86400;
}

describe('el lector de @Cron del contrato', () => {
  it('reconoce cualquier argumento y el @ConRegistro en cualquier lugar del bloque de decoradores', () => {
    const texto = `
      class A {
        @Cron('0 0 * * * *', { timeZone: ZONA }) // cada hora
        @ConRegistro(ProcessName.FLEET_ALERTS)
        async a() {}

        @ConRegistro(ProcessName.STOCK_LOW_ALERT)
        @Cron(CronExpression.EVERY_HOUR)
        async b() {}

        @Cron(
          '0 */5 * * * *',
          { timeZone: ZONA },
        )
        // comentario entre decoradores
        @ConRegistro(ProcessName.IMPORT_CLEANUP)
        async c() {}

        @Cron('0 * * * *')
        async sinRegistro() {}
      }`;
    expect(cronsDe(texto, 'x.ts').map((c) => [c.expresion, c.proceso])).toEqual(
      [
        ['0 0 * * * *', 'FLEET_ALERTS'],
        ['CronExpression.EVERY_HOUR', 'STOCK_LOW_ALERT'],
        ['0 */5 * * * *', 'IMPORT_CLEANUP'],
        ['0 * * * *', null],
      ],
    );
  });
});

describe('contrato del monitoreo de procesos', () => {
  const todos = crons();

  it('encuentra los crons del back', () => {
    expect(todos.length).toBeGreaterThanOrEqual(30);
  });

  it('todo método con @Cron tiene su @ConRegistro', () => {
    expect(
      todos
        .filter((c) => !c.proceso)
        .map((c) => `${c.archivo}: ${c.expresion}`),
    ).toEqual([]);
  });

  it('cada proceso del catálogo tiene su cron y ninguno se registra dos veces', () => {
    const registrados = todos.flatMap((c) => (c.proceso ? [c.proceso] : []));
    const esperados = Object.keys(ProcessName).sort();
    expect([...registrados].sort()).toEqual(esperados);
  });

  it('la cadencia del catálogo es la de la expresión del @Cron', () => {
    const distintas = todos.flatMap((c) => {
      if (!c.proceso) return [];
      const proceso = ProcessName[c.proceso as keyof typeof ProcessName];
      const catalogada = CATALOGO[proceso].periodSeconds;
      const real = periodoDeCron(CRON_EXPRESSION[c.expresion] ?? c.expresion);
      return catalogada === real
        ? []
        : [
            `${c.proceso}: catálogo ${catalogada} s, @Cron ${real} s (${c.expresion})`,
          ];
    });
    expect(distintas).toEqual([]);
  });

  it.each([
    ['*/15 * * * * *', 15],
    ['15,45 * * * * *', 30],
    ['0 */5 * * * *', 300],
    ['30 */5 * * * *', 300],
    ['0 * * * * *', 60],
    ['0 0 * * * *', 3600],
    ['0 * * * *', 3600],
    ['30 23 * * *', 86400],
    ['0 30 1 * * *', 86400],
  ])('periodoDeCron(%s) = %i s', (expresion, segundos) => {
    expect(periodoDeCron(expresion)).toBe(segundos);
  });
});
