import { DataSource, QueryRunner } from 'typeorm';
import { ActorEnLaBase, esEscritura } from './actor-en-la-base';
import { auditContext } from './audit-context';

const ACTOR = {
  userId: 'u-1',
  ip: '10.0.0.1',
  distributorId: 'd-1',
};

/** Un query runner mínimo: registra cada sentencia y respeta el estado de transacción. */
function crearRunner() {
  const sentencias: string[] = [];
  const parametros: unknown[][] = [];
  const runner = {
    isTransactionActive: false,
    query: jest.fn((sql: string, params?: unknown[]) => {
      sentencias.push(sql.trim().split(/\s+/)[0].toUpperCase());
      parametros.push(params ?? []);
      return Promise.resolve([]);
    }),
    startTransaction: jest.fn(async () => {
      runner.isTransactionActive = true;
      await runner.query('START TRANSACTION');
      await subscriber.afterTransactionStart({
        queryRunner: runner as unknown as QueryRunner,
      } as never);
    }),
    commitTransaction: jest.fn(async () => {
      await runner.query('COMMIT');
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(async () => {
      await runner.query('ROLLBACK');
      runner.isTransactionActive = false;
    }),
  };
  return { runner, sentencias, parametros };
}

let subscriber: ActorEnLaBase;
let driver: { createQueryRunner: jest.Mock };
let creado: ReturnType<typeof crearRunner>;

beforeEach(() => {
  creado = crearRunner();
  driver = { createQueryRunner: jest.fn(() => creado.runner) };
  const dataSource = { subscribers: [], driver } as unknown as DataSource;
  subscriber = new ActorEnLaBase(dataSource);
});

/** El runner que entrega el driver ya envuelto. */
const nuevoRunner = () =>
  (driver.createQueryRunner as (modo: string) => QueryRunner)('master');

describe('ActorEnLaBase', () => {
  it('se registra como subscriber de TypeORM', () => {
    const dataSource = { subscribers: [], driver } as unknown as DataSource;
    const s = new ActorEnLaBase(dataSource);
    expect(dataSource.subscribers).toContain(s);
  });

  it('al empezar una transacción fija usuario, ip y distribuidora del request', async () => {
    await auditContext.run(ACTOR, () => nuevoRunner().startTransaction());
    expect(creado.sentencias).toEqual(['START', 'SELECT']);
    expect(creado.parametros[1]).toEqual(['u-1', '10.0.0.1', 'd-1']);
  });

  it('fuera de un request no fija nada: el trigger asienta «sistema»', async () => {
    await nuevoRunner().startTransaction();
    expect(creado.sentencias).toEqual(['START']);
  });

  it('una escritura suelta del request va en su propia transacción con el actor', async () => {
    await auditContext.run(ACTOR, () =>
      nuevoRunner().query('UPDATE "car" SET "x" = $1', [1]),
    );
    expect(creado.sentencias).toEqual(['START', 'SELECT', 'UPDATE', 'COMMIT']);
  });

  it('un WITH que escribe también se envuelve', async () => {
    await auditContext.run(ACTOR, () =>
      nuevoRunner().query('WITH a AS (SELECT 1) UPDATE "car" SET x = 1'),
    );
    expect(creado.sentencias).toContain('COMMIT');
  });

  it('si la escritura falla deshace y propaga el error', async () => {
    creado.runner.query.mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT')) return Promise.reject(new Error('boom'));
      return Promise.resolve([]);
    });
    await expect(
      auditContext.run(ACTOR, () =>
        nuevoRunner().query('INSERT INTO "car" ...'),
      ),
    ).rejects.toThrow('boom');
    expect(creado.runner.rollbackTransaction).toHaveBeenCalled();
    expect(creado.runner.isTransactionActive).toBe(false);
  });

  it('las lecturas no abren transacción', async () => {
    await auditContext.run(ACTOR, () =>
      nuevoRunner().query('SELECT * FROM "car"'),
    );
    expect(creado.sentencias).toEqual(['SELECT']);
  });

  it('dentro de una transacción ya abierta no envuelve nada', async () => {
    creado.runner.isTransactionActive = true;
    await auditContext.run(ACTOR, () =>
      nuevoRunner().query('UPDATE "car" SET "x" = 1'),
    );
    expect(creado.sentencias).toEqual(['UPDATE']);
  });

  it('una escritura sin contexto (cron, script) va como está', async () => {
    await nuevoRunner().query('UPDATE "car" SET "x" = 1');
    expect(creado.sentencias).toEqual(['UPDATE']);
  });

  it('un CALL del request va sin envolver: el procedimiento controla su propia transacción', async () => {
    await auditContext.run(ACTOR, () =>
      nuevoRunner().query('CALL conciliar_stock_del_dia($1)', ['d']),
    );
    expect(creado.sentencias).toEqual(['CALL']);
  });

  it('si falla al abrir la transacción deshace y propaga el error', async () => {
    creado.runner.startTransaction.mockImplementation(() => {
      creado.runner.isTransactionActive = true;
      return Promise.reject(new Error('sin conexión'));
    });
    await expect(
      auditContext.run(ACTOR, () => nuevoRunner().query('DELETE FROM "car"')),
    ).rejects.toThrow('sin conexión');
    expect(creado.runner.rollbackTransaction).toHaveBeenCalled();
  });
});

describe('esEscritura', () => {
  it.each([
    'INSERT INTO "car" ...',
    '  update "car" set x = 1',
    'DELETE FROM "car"',
    'MERGE INTO "car" ...',
    'TRUNCATE "car"',
    'COPY "car" FROM STDIN',
    'WITH a AS (SELECT 1) DELETE FROM "car"',
    '/* nota */ UPDATE "car" SET x = 1',
    '-- nota\nINSERT INTO "car" ...',
    '(UPDATE "car" SET x = 1)',
  ])('%s es escritura', (sql) => {
    expect(esEscritura(sql)).toBe(true);
  });

  it.each([
    'SELECT * FROM "car"',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    'START TRANSACTION',
    'COMMIT',
    'CALL conciliar_stock_del_dia($1)',
    "SELECT set_config('splg.user_id', $1, true)",
    '/* UPDATE */ SELECT 1',
  ])('%s no lo es', (sql) => {
    expect(esEscritura(sql)).toBe(false);
  });
});
