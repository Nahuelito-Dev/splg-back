import { randomUUID } from 'crypto';
import { FindOperator } from 'typeorm';

type Fila = Record<string, unknown>;
type Condicion = Record<string, unknown>;

function cumple(fila: Fila, where: Condicion): boolean {
  return Object.entries(where).every(([clave, esperado]) => {
    const actual = fila[clave];
    if (esperado instanceof FindOperator) {
      const valor = esperado.value as unknown;
      if (esperado.type === 'in') return (valor as unknown[]).includes(actual);
      if (esperado.type === 'lessThanOrEqual') {
        return (actual as Date).getTime() <= (valor as Date).getTime();
      }
      throw new Error(`Operador no soportado en el fake: ${esperado.type}`);
    }
    return actual === esperado;
  });
}

/**
 * Repositorio en memoria con lo mínimo que usa el planificador (`find`,
 * `findOne`, `save`, `update`…): sirve para probar las reglas del caso sin
 * una base. `ancla` completa las relaciones que el servicio lee de la fila.
 */
export class RepoEnMemoria<T extends object> {
  filas: T[] = [];

  constructor(
    private readonly clave: string,
    private readonly ancla: (fila: T) => void = () => undefined,
  ) {}

  create(datos: Partial<T>): T {
    return { ...datos } as T;
  }

  agregar(fila: T): T {
    const f = fila as Fila;
    if (!f[this.clave]) f[this.clave] = randomUUID();
    this.filas.push(fila);
    return fila;
  }

  save(entrada: T): Promise<T>;
  save(entrada: T[]): Promise<T[]>;
  save(entrada: T | T[]): Promise<T | T[]> {
    const guardar = (fila: T): T => {
      const f = fila as Fila;
      if (!f[this.clave]) f[this.clave] = randomUUID();
      if (!this.filas.includes(fila)) this.filas.push(fila);
      return fila;
    };
    return Promise.resolve(
      Array.isArray(entrada) ? entrada.map(guardar) : guardar(entrada),
    );
  }

  find(opciones: { where?: Condicion } = {}): Promise<T[]> {
    const where = opciones.where ?? {};
    const r = this.filas.filter((f) => cumple(f as Fila, where));
    r.forEach((f) => this.ancla(f));
    return Promise.resolve(r);
  }

  async findOne(opciones: { where?: Condicion } = {}): Promise<T | null> {
    return (await this.find(opciones))[0] ?? null;
  }

  async findOneOrFail(opciones: { where?: Condicion } = {}): Promise<T> {
    const fila = await this.findOne(opciones);
    if (!fila) throw new Error('findOneOrFail: sin resultado');
    return fila;
  }

  async findAndCount(
    opciones: { where?: Condicion } = {},
  ): Promise<[T[], number]> {
    const r = await this.find(opciones);
    return [r, r.length];
  }

  update(where: Condicion, cambios: Partial<T>): Promise<void> {
    this.filas
      .filter((f) => cumple(f as Fila, where))
      .forEach((f) => Object.assign(f, cambios));
    return Promise.resolve();
  }
}

/** Un `DataSource` mínimo: la transacción corre con un manager que reparte los repos. */
export function dataSourceEnMemoria(
  repos: Map<unknown, RepoEnMemoria<object>>,
) {
  const manager = {
    getRepository: (entidad: unknown) => {
      const repo = repos.get(entidad);
      if (!repo) throw new Error('Repositorio no registrado en el fake');
      return repo;
    },
  };
  return {
    transaction: <R>(fn: (m: typeof manager) => Promise<R>) => fn(manager),
  };
}
