/**
 * Caja (M-D parte 1) contra la API con Postgres y Redis reales: cajas, sesiones
 * con arqueo, libro de movimientos, categorías, transferencias, anulaciones,
 * aislamiento entre distribuidoras, idempotencia y concurrencia sobre el saldo.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { codigoSqlDelError } from '../../src/common/errors/db-exceptions';
import { conIdempotencia } from './setup/con-idempotencia';
import { Finanzas, Headers, cuerpo } from './setup/finanzas';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';

/** Cuenta los deadlocks que `withTransactionRetry` reintenta en silencio. */
const mockReintentos = { n: 0 };
jest.mock('../../src/common/utils/with-transaction-retry', () => {
  const real = jest.requireActual<
    typeof import('../../src/common/utils/with-transaction-retry')
  >('../../src/common/utils/with-transaction-retry');
  return {
    ...real,
    withTransactionRetry: <T>(
      fn: () => Promise<T>,
      options?: Parameters<typeof real.withTransactionRetry>[1],
    ): Promise<T> =>
      real.withTransactionRetry(async () => {
        try {
          return await fn();
        } catch (error) {
          const code = codigoSqlDelError(error);
          if (code === '40P01' || code === '40001') mockReintentos.n += 1;
          throw error;
        }
      }, options),
  };
});

interface Caja {
  cashBoxId: string;
  name: string;
  kind: string;
  balance: number;
  requiresSession: boolean;
  isActive: boolean;
  openSessionId: string | null;
}
interface Sesion {
  sessionId: string;
  cashBoxId: string;
  status: string;
  openingAmount: number;
  expectedAmount: number | null;
  countedAmount: number | null;
  difference: number | null;
}
interface SesionDetalle extends Sesion {
  currentBalance: number;
  totalIn: number;
  totalOut: number;
  movements: Movimiento[];
}
interface Movimiento {
  movementId: string;
  cashBoxId: string;
  direction: string;
  amount: number;
  categoryName: string;
  referenceType: string;
  reversesMovementId: string | null;
  reversed: boolean;
  description: string;
}
interface Categoria {
  categoryId: string;
  name: string;
  direction: string;
  systemCode: string | null;
  isActive: boolean;
}
interface Pagina<T> {
  data: T[];
  total: number;
}

describe('Caja (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let f: Finanzas;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    f = new Finanzas(env);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    mockReintentos.n = 0;
  });

  const http = () => conIdempotencia(env.app.getHttpServer());

  const crearCaja = async (
    h: Headers,
    datos: { name: string; kind?: string; requiresSession?: boolean },
  ) =>
    cuerpo<Caja>(
      await http()
        .post('/cash-boxes')
        .set(h)
        .send({ kind: 'cash', ...datos })
        .expect(201),
    );

  const categorias = async (h: Headers, direction?: string) =>
    cuerpo<Pagina<Categoria>>(
      await http()
        .get('/cash-categories')
        .query(direction ? { direction } : {})
        .set(h)
        .expect(200),
    ).data;

  const deSistema = async (h: Headers, code: string) => {
    const lista = await categorias(h);
    const c = lista.find((x) => x.systemCode === code);
    if (!c) throw new Error(`Falta la categoría de sistema ${code}`);
    return c;
  };

  const categoriaPropia = async (
    h: Headers,
    name: string,
    direction: 'income' | 'expense',
  ) =>
    cuerpo<Categoria>(
      await http()
        .post('/cash-categories')
        .set(h)
        .send({ name, direction })
        .expect(201),
    );

  const abrir = async (h: Headers, cajaId: string, openingAmount: number) =>
    cuerpo<Sesion>(
      await http()
        .post(`/cash-boxes/${cajaId}/sessions`)
        .set(h)
        .send({ openingAmount })
        .expect(201),
    );

  const mover = (
    h: Headers,
    cashBoxId: string,
    direction: 'in' | 'out',
    amount: number,
    categoryId: string,
    description = 'Movimiento de prueba',
  ) =>
    http()
      .post('/cash-movements')
      .set(h)
      .send({ cashBoxId, direction, amount, categoryId, description });

  const saldoDe = async (id: string) =>
    Number(
      (
        await ds.query<Array<{ balance: string }>>(
          `SELECT balance FROM cash_box WHERE cash_box_id = $1`,
          [id],
        )
      )[0].balance,
    );
  const sumaDelLibro = async (id: string) =>
    Number(
      (
        await ds.query<Array<{ total: string }>>(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS total
           FROM cash_movement WHERE cash_box_id = $1`,
          [id],
        )
      )[0].total,
    );

  describe('cajas (CU-225, CU-264)', () => {
    it('crea una caja de efectivo que exige sesión, la lista con su saldo y rechaza el nombre repetido y el tipo inválido', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja mostrador' });
      expect(caja).toMatchObject({
        kind: 'cash',
        balance: 0,
        requiresSession: true,
        isActive: true,
        openSessionId: null,
      });
      const banco = await crearCaja(a.headers, {
        name: 'Banco Nación',
        kind: 'bank',
      });
      expect(banco.requiresSession).toBe(false);

      const lista = cuerpo<Pagina<Caja>>(
        await http().get('/cash-boxes').set(a.headers).expect(200),
      );
      // La "Caja central" que siembra el alta de la distribuidora y las dos nuevas.
      expect(lista.total).toBe(3);
      expect(lista.data.map((c) => c.name)).toContain('Caja central');

      await http()
        .post('/cash-boxes')
        .set(a.headers)
        .send({ name: 'caja MOSTRADOR', kind: 'cash' })
        .expect(409);
      await http()
        .post('/cash-boxes')
        .set(a.headers)
        .send({ name: 'Otra', kind: 'cheque' })
        .expect(400);
    });

    it('modifica nombre y estado; desactivar con una sesión abierta es 409', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const editada = cuerpo<Caja>(
        await http()
          .patch(`/cash-boxes/${caja.cashBoxId}`)
          .set(a.headers)
          .send({ name: 'Caja principal' })
          .expect(200),
      );
      expect(editada.name).toBe('Caja principal');

      await abrir(a.headers, caja.cashBoxId, 0);
      await http()
        .patch(`/cash-boxes/${caja.cashBoxId}`)
        .set(a.headers)
        .send({ isActive: false })
        .expect(409);
    });

    it('una caja de otra distribuidora responde 404 en todo', async () => {
      const a = await f.distribuidora();
      const b = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja A' });
      await http()
        .get(`/cash-boxes/${caja.cashBoxId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/cash-boxes/${caja.cashBoxId}`)
        .set(b.headers)
        .send({ name: 'Robada' })
        .expect(404);
      await http()
        .post(`/cash-boxes/${caja.cashBoxId}/sessions`)
        .set(b.headers)
        .send({ openingAmount: 0 })
        .expect(404);
      await http()
        .get(`/cash-boxes/${caja.cashBoxId}/sessions`)
        .set(b.headers)
        .expect(404);
      await http()
        .get('/cash-movements')
        .query({ cashBoxId: caja.cashBoxId })
        .set(b.headers)
        .expect(404);
      const cat = await deSistema(b.headers, 'cash_surplus');
      await mover(b.headers, caja.cashBoxId, 'in', 10, cat.categoryId).expect(
        404,
      );
    });
  });

  describe('sesión, movimientos y arqueo (CU-226, 227, 228, 309)', () => {
    it('sin sesión abierta una caja que la exige rechaza movimientos (409); abrir con otro saldo asienta el ajuste de apertura', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(
        a.headers,
        'Venta mostrador',
        'income',
      );
      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        100,
        ingreso.categoryId,
      ).expect(409);

      const sesion = await abrir(a.headers, caja.cashBoxId, 5000);
      expect(sesion).toMatchObject({ status: 'open', openingAmount: 5000 });
      expect(await saldoDe(caja.cashBoxId)).toBe(5000);

      const libro = cuerpo<Pagina<Movimiento>>(
        await http()
          .get('/cash-movements')
          .query({ cashBoxId: caja.cashBoxId })
          .set(a.headers)
          .expect(200),
      );
      expect(libro.data).toHaveLength(1);
      expect(libro.data[0]).toMatchObject({
        direction: 'in',
        amount: 5000,
        referenceType: 'session_opening',
        categoryName: 'Sobrante de caja',
      });

      // Dos aperturas no conviven.
      await http()
        .post(`/cash-boxes/${caja.cashBoxId}/sessions`)
        .set(a.headers)
        .send({ openingAmount: 5000 })
        .expect(409);
      // Monto negativo.
      await http()
        .post(`/cash-boxes/${caja.cashBoxId}/sessions`)
        .set(a.headers)
        .send({ openingAmount: -1 })
        .expect(400);
    });

    it('una caja que no exige sesión no se abre (400)', async () => {
      const a = await f.distribuidora();
      const banco = await crearCaja(a.headers, { name: 'Banco', kind: 'bank' });
      await http()
        .post(`/cash-boxes/${banco.cashBoxId}/sessions`)
        .set(a.headers)
        .send({ openingAmount: 0 })
        .expect(400);
    });

    it('entrada y salida: validan categoría, importe y saldo; el saldo es la suma del libro', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(
        a.headers,
        'Venta mostrador',
        'income',
      );
      const gasto = await categoriaPropia(a.headers, 'Limpieza', 'expense');
      await abrir(a.headers, caja.cashBoxId, 1000);

      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        2500.5,
        ingreso.categoryId,
      ).expect(201);
      await mover(
        a.headers,
        caja.cashBoxId,
        'out',
        300.25,
        gasto.categoryId,
      ).expect(201);
      expect(await saldoDe(caja.cashBoxId)).toBe(3200.25);

      // Categoría de otro sentido.
      await mover(
        a.headers,
        caja.cashBoxId,
        'out',
        10,
        ingreso.categoryId,
      ).expect(400);
      await mover(a.headers, caja.cashBoxId, 'in', 10, gasto.categoryId).expect(
        400,
      );
      // Importe no positivo o con más de dos decimales.
      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        0,
        ingreso.categoryId,
      ).expect(400);
      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        -5,
        ingreso.categoryId,
      ).expect(400);
      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        1.234,
        ingreso.categoryId,
      ).expect(400);
      // Efectivo no puede quedar negativo.
      await mover(
        a.headers,
        caja.cashBoxId,
        'out',
        99999,
        gasto.categoryId,
      ).expect(409);
      // Categoría inexistente.
      await mover(a.headers, caja.cashBoxId, 'in', 10, randomUUID()).expect(
        404,
      );

      expect(await saldoDe(caja.cashBoxId)).toBe(3200.25);
      expect(await sumaDelLibro(caja.cashBoxId)).toBe(3200.25);
    });

    it('la misma Idempotency-Key con otro cuerpo es 422 y con el mismo cuerpo no duplica el asiento', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(a.headers, 'Venta', 'income');
      await abrir(a.headers, caja.cashBoxId, 0);
      const clave = randomUUID();
      const cuerpoUno = {
        cashBoxId: caja.cashBoxId,
        direction: 'in',
        amount: 100,
        categoryId: ingreso.categoryId,
        description: 'Cobro',
      };
      await http()
        .post('/cash-movements')
        .set(a.headers)
        .set('Idempotency-Key', clave)
        .send(cuerpoUno)
        .expect(201);
      await http()
        .post('/cash-movements')
        .set(a.headers)
        .set('Idempotency-Key', clave)
        .send(cuerpoUno)
        .expect(201);
      await http()
        .post('/cash-movements')
        .set(a.headers)
        .set('Idempotency-Key', clave)
        .send({ ...cuerpoUno, amount: 999 })
        .expect(422);
      expect(await saldoDe(caja.cashBoxId)).toBe(100);
    });

    it('cierra con arqueo: un faltante asienta el ajuste y el saldo queda igual a lo contado', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(a.headers, 'Venta', 'income');
      const gasto = await categoriaPropia(a.headers, 'Limpieza', 'expense');
      const sesion = await abrir(a.headers, caja.cashBoxId, 5000);
      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        2000,
        ingreso.categoryId,
      ).expect(201);
      await mover(
        a.headers,
        caja.cashBoxId,
        'out',
        1000,
        gasto.categoryId,
      ).expect(201);

      const detalle = cuerpo<SesionDetalle>(
        await http()
          .get(`/cash-sessions/${sesion.sessionId}`)
          .set(a.headers)
          .expect(200),
      );
      expect(detalle).toMatchObject({
        currentBalance: 6000,
        totalIn: 7000,
        totalOut: 1000,
      });
      expect(detalle.movements).toHaveLength(3);

      await http()
        .patch(`/cash-sessions/${sesion.sessionId}/close`)
        .set(a.headers)
        .send({ countedAmount: -1 })
        .expect(400);
      const cerrada = cuerpo<Sesion>(
        await http()
          .patch(`/cash-sessions/${sesion.sessionId}/close`)
          .set(a.headers)
          .send({ countedAmount: 5500, notes: 'Faltaron 500' })
          .expect(200),
      );
      expect(cerrada).toMatchObject({
        status: 'closed',
        expectedAmount: 6000,
        countedAmount: 5500,
        difference: -500,
      });
      expect(await saldoDe(caja.cashBoxId)).toBe(5500);
      expect(await sumaDelLibro(caja.cashBoxId)).toBe(5500);
      const ajuste = cuerpo<Pagina<Movimiento>>(
        await http()
          .get('/cash-movements')
          .query({
            cashBoxId: caja.cashBoxId,
            referenceType: 'session_closing',
          })
          .set(a.headers)
          .expect(200),
      );
      expect(ajuste.data).toHaveLength(1);
      expect(ajuste.data[0]).toMatchObject({
        direction: 'out',
        amount: 500,
        categoryName: 'Faltante de caja',
      });

      await http()
        .patch(`/cash-sessions/${sesion.sessionId}/close`)
        .set(a.headers)
        .send({ countedAmount: 5500 })
        .expect(409);
      // Cerrada, la caja vuelve a exigir sesión.
      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        10,
        ingreso.categoryId,
      ).expect(409);
    });

    it('un sobrante se asienta como entrada; sin diferencia no hay ajuste', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const s1 = await abrir(a.headers, caja.cashBoxId, 1000);
      const sobrante = cuerpo<Sesion>(
        await http()
          .patch(`/cash-sessions/${s1.sessionId}/close`)
          .set(a.headers)
          .send({ countedAmount: 1200 })
          .expect(200),
      );
      expect(sobrante.difference).toBe(200);
      expect(await saldoDe(caja.cashBoxId)).toBe(1200);

      const s2 = await abrir(a.headers, caja.cashBoxId, 1200);
      const exacta = cuerpo<Sesion>(
        await http()
          .patch(`/cash-sessions/${s2.sessionId}/close`)
          .set(a.headers)
          .send({ countedAmount: 1200 })
          .expect(200),
      );
      expect(exacta.difference).toBe(0);
      const cierres = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM cash_movement WHERE session_id = $1 AND reference_type = 'session_closing'`,
        [s2.sessionId],
      );
      expect(cierres[0].n).toBe(0);
    });

    it('una sesión de otra distribuidora es 404', async () => {
      const a = await f.distribuidora();
      const b = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja A' });
      const sesion = await abrir(a.headers, caja.cashBoxId, 0);
      await http()
        .get(`/cash-sessions/${sesion.sessionId}`)
        .set(b.headers)
        .expect(404);
      await http()
        .patch(`/cash-sessions/${sesion.sessionId}/close`)
        .set(b.headers)
        .send({ countedAmount: 0 })
        .expect(404);
    });
  });

  describe('anulación (CU-229)', () => {
    it('anula con un contraasiento; una sola vez; una anulación no se anula; falta el motivo es 400', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(a.headers, 'Venta', 'income');
      await abrir(a.headers, caja.cashBoxId, 0);
      const mov = cuerpo<Movimiento>(
        await mover(
          a.headers,
          caja.cashBoxId,
          'in',
          800,
          ingreso.categoryId,
        ).expect(201),
      );

      await http()
        .post(`/cash-movements/${mov.movementId}/reverse`)
        .set(a.headers)
        .send({})
        .expect(400);
      const anulacion = cuerpo<Movimiento>(
        await http()
          .post(`/cash-movements/${mov.movementId}/reverse`)
          .set(a.headers)
          .send({ reason: 'Se cargó dos veces' })
          .expect(201),
      );
      expect(anulacion).toMatchObject({
        direction: 'out',
        amount: 800,
        reversesMovementId: mov.movementId,
        referenceType: 'reversal',
      });
      expect(await saldoDe(caja.cashBoxId)).toBe(0);

      await http()
        .post(`/cash-movements/${mov.movementId}/reverse`)
        .set(a.headers)
        .send({ reason: 'Otra vez' })
        .expect(409);
      await http()
        .post(`/cash-movements/${anulacion.movementId}/reverse`)
        .set(a.headers)
        .send({ reason: 'Anular la anulación' })
        .expect(409);

      const libro = cuerpo<Pagina<Movimiento>>(
        await http()
          .get('/cash-movements')
          .query({ cashBoxId: caja.cashBoxId })
          .set(a.headers)
          .expect(200),
      );
      expect(
        libro.data.find((m) => m.movementId === mov.movementId)?.reversed,
      ).toBe(true);
    });

    it('si el contraasiento dejaría la caja de efectivo en negativo es 409', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(a.headers, 'Venta', 'income');
      const gasto = await categoriaPropia(a.headers, 'Gasto', 'expense');
      await abrir(a.headers, caja.cashBoxId, 0);
      const entrada = cuerpo<Movimiento>(
        await mover(
          a.headers,
          caja.cashBoxId,
          'in',
          500,
          ingreso.categoryId,
        ).expect(201),
      );
      await mover(
        a.headers,
        caja.cashBoxId,
        'out',
        400,
        gasto.categoryId,
      ).expect(201);
      await http()
        .post(`/cash-movements/${entrada.movementId}/reverse`)
        .set(a.headers)
        .send({ reason: 'No alcanza' })
        .expect(409);
      expect(await saldoDe(caja.cashBoxId)).toBe(100);
    });

    it('anular un movimiento de otra distribuidora es 404', async () => {
      const a = await f.distribuidora();
      const b = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja A' });
      const ingreso = await categoriaPropia(a.headers, 'Venta', 'income');
      await abrir(a.headers, caja.cashBoxId, 0);
      const mov = cuerpo<Movimiento>(
        await mover(
          a.headers,
          caja.cashBoxId,
          'in',
          50,
          ingreso.categoryId,
        ).expect(201),
      );
      await http()
        .post(`/cash-movements/${mov.movementId}/reverse`)
        .set(b.headers)
        .send({ reason: 'Ajeno' })
        .expect(404);
    });

    it('dos anulaciones simultáneas del mismo movimiento: gana una sola', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(a.headers, 'Venta', 'income');
      await abrir(a.headers, caja.cashBoxId, 0);
      const mov = cuerpo<Movimiento>(
        await mover(
          a.headers,
          caja.cashBoxId,
          'in',
          500,
          ingreso.categoryId,
        ).expect(201),
      );
      const respuestas = await Promise.all(
        [1, 2, 3, 4].map(() =>
          http()
            .post(`/cash-movements/${mov.movementId}/reverse`)
            .set(a.headers)
            .send({ reason: 'Carrera' }),
        ),
      );
      const estados = respuestas.map((r) => r.status).sort();
      expect(estados).toEqual([201, 409, 409, 409]);
      expect(await saldoDe(caja.cashBoxId)).toBe(0);
      expect(mockReintentos.n).toBe(0);
    });
  });

  describe('transferencia entre cajas (CU-310)', () => {
    it('mueve el dinero en una sola transacción: salida en el origen y entrada en el destino', async () => {
      const a = await f.distribuidora();
      const efectivo = await crearCaja(a.headers, { name: 'Efectivo' });
      const banco = await crearCaja(a.headers, { name: 'Banco', kind: 'bank' });
      await abrir(a.headers, efectivo.cashBoxId, 3000);

      const r = cuerpo<{ out: Movimiento; in: Movimiento }>(
        await http()
          .post('/cash-movements/transfer')
          .set(a.headers)
          .send({
            fromCashBoxId: efectivo.cashBoxId,
            toCashBoxId: banco.cashBoxId,
            amount: 1200,
            description: 'Depósito',
          })
          .expect(201),
      );
      expect(r.out).toMatchObject({
        direction: 'out',
        amount: 1200,
        referenceType: 'box_transfer',
      });
      expect(r.in).toMatchObject({
        direction: 'in',
        amount: 1200,
        cashBoxId: banco.cashBoxId,
      });
      expect(await saldoDe(efectivo.cashBoxId)).toBe(1800);
      expect(await saldoDe(banco.cashBoxId)).toBe(1200);
    });

    it('valida: mismo origen y destino (400), monto (400), saldo del origen (409), sesión (409), caja ajena (404)', async () => {
      const a = await f.distribuidora();
      const b = await f.distribuidora();
      const efectivo = await crearCaja(a.headers, { name: 'Efectivo' });
      const banco = await crearCaja(a.headers, { name: 'Banco', kind: 'bank' });
      const ajena = await crearCaja(b.headers, { name: 'Ajena', kind: 'bank' });
      const enviar = (desde: string, hasta: string, amount: number) =>
        http()
          .post('/cash-movements/transfer')
          .set(a.headers)
          .send({ fromCashBoxId: desde, toCashBoxId: hasta, amount });

      await enviar(efectivo.cashBoxId, efectivo.cashBoxId, 10).expect(400);
      await enviar(efectivo.cashBoxId, banco.cashBoxId, 0).expect(400);
      // Origen de efectivo sin sesión abierta.
      await enviar(efectivo.cashBoxId, banco.cashBoxId, 10).expect(409);
      await abrir(a.headers, efectivo.cashBoxId, 100);
      await enviar(efectivo.cashBoxId, banco.cashBoxId, 5000).expect(409);
      await enviar(efectivo.cashBoxId, ajena.cashBoxId, 10).expect(404);
      expect(await saldoDe(efectivo.cashBoxId)).toBe(100);
      expect(await saldoDe(banco.cashBoxId)).toBe(0);
    });

    it('si el destino rechaza la entrada (caja desactivada) se deshace también la salida', async () => {
      const a = await f.distribuidora();
      const efectivo = await crearCaja(a.headers, { name: 'Efectivo' });
      const banco = await crearCaja(a.headers, { name: 'Banco', kind: 'bank' });
      await abrir(a.headers, efectivo.cashBoxId, 1000);
      await http()
        .patch(`/cash-boxes/${banco.cashBoxId}`)
        .set(a.headers)
        .send({ isActive: false })
        .expect(200);
      await http()
        .post('/cash-movements/transfer')
        .set(a.headers)
        .send({
          fromCashBoxId: efectivo.cashBoxId,
          toCashBoxId: banco.cashBoxId,
          amount: 400,
        })
        .expect(409);
      expect(await saldoDe(efectivo.cashBoxId)).toBe(1000);
      const salidas = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM cash_movement WHERE reference_type = 'box_transfer'`,
      );
      expect(salidas[0].n).toBe(0);
    });

    it('transferencias cruzadas simultáneas no se interbloquean y conservan el total', async () => {
      const a = await f.distribuidora();
      const uno = await crearCaja(a.headers, {
        name: 'Banco uno',
        kind: 'bank',
      });
      const dos = await crearCaja(a.headers, {
        name: 'Banco dos',
        kind: 'bank',
      });
      const cat = await deSistema(a.headers, 'cash_surplus');
      await mover(a.headers, uno.cashBoxId, 'in', 1000, cat.categoryId).expect(
        201,
      );
      await mover(a.headers, dos.cashBoxId, 'in', 1000, cat.categoryId).expect(
        201,
      );
      const pedidos = Array.from({ length: 12 }, (_, i) =>
        http()
          .post('/cash-movements/transfer')
          .set(a.headers)
          .send(
            i % 2 === 0
              ? {
                  fromCashBoxId: uno.cashBoxId,
                  toCashBoxId: dos.cashBoxId,
                  amount: 10,
                }
              : {
                  fromCashBoxId: dos.cashBoxId,
                  toCashBoxId: uno.cashBoxId,
                  amount: 10,
                },
          ),
      );
      const respuestas = await Promise.all(pedidos);
      expect(respuestas.every((r) => r.status === 201)).toBe(true);
      expect(mockReintentos.n).toBe(0);
      expect(
        (await saldoDe(uno.cashBoxId)) + (await saldoDe(dos.cashBoxId)),
      ).toBe(2000);
    });
  });

  describe('concurrencia sobre el saldo', () => {
    it('salidas simultáneas nunca dejan la caja de efectivo en negativo y el saldo es la suma del libro', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const gasto = await categoriaPropia(a.headers, 'Gasto', 'expense');
      await abrir(a.headers, caja.cashBoxId, 500);
      const respuestas = await Promise.all(
        Array.from({ length: 12 }, () =>
          mover(a.headers, caja.cashBoxId, 'out', 100, gasto.categoryId),
        ),
      );
      const ok = respuestas.filter((r) => r.status === 201).length;
      const rechazadas = respuestas.filter((r) => r.status === 409).length;
      expect(ok).toBe(5);
      expect(rechazadas).toBe(7);
      expect(await saldoDe(caja.cashBoxId)).toBe(0);
      expect(await sumaDelLibro(caja.cashBoxId)).toBe(0);
      expect(mockReintentos.n).toBe(0);
    });
  });

  describe('categorías (CU-230, CU-265)', () => {
    it('siembra las de sistema, crea, rechaza duplicadas, renombra y desactiva; las de sistema no se tocan', async () => {
      const a = await f.distribuidora();
      const lista = await categorias(a.headers);
      expect(lista.filter((c) => c.systemCode)).toHaveLength(10);

      const nueva = await categoriaPropia(a.headers, 'Propinas', 'income');
      await http()
        .post('/cash-categories')
        .set(a.headers)
        .send({ name: 'propinas', direction: 'income' })
        .expect(409);
      // El mismo nombre en el otro sentido es otra categoría.
      await categoriaPropia(a.headers, 'Propinas', 'expense');

      const renombrada = cuerpo<Categoria>(
        await http()
          .patch(`/cash-categories/${nueva.categoryId}`)
          .set(a.headers)
          .send({ name: 'Propinas del mostrador' })
          .expect(200),
      );
      expect(renombrada.name).toBe('Propinas del mostrador');

      const sistema = await deSistema(a.headers, 'driver_settlement');
      await http()
        .patch(`/cash-categories/${sistema.categoryId}`)
        .set(a.headers)
        .send({ name: 'Otra cosa' })
        .expect(409);
      await http()
        .delete(`/cash-categories/${sistema.categoryId}`)
        .set(a.headers)
        .expect(409);

      const baja = cuerpo<Categoria>(
        await http()
          .delete(`/cash-categories/${nueva.categoryId}`)
          .set(a.headers)
          .expect(200),
      );
      expect(baja.isActive).toBe(false);
      expect(
        (await categorias(a.headers)).some(
          (c) => c.categoryId === nueva.categoryId,
        ),
      ).toBe(false);
    });

    it('una categoría de otra distribuidora es 404', async () => {
      const a = await f.distribuidora();
      const b = await f.distribuidora();
      const propia = await categoriaPropia(a.headers, 'Solo mía', 'income');
      await http()
        .patch(`/cash-categories/${propia.categoryId}`)
        .set(b.headers)
        .send({ name: 'x' })
        .expect(404);
      await http()
        .delete(`/cash-categories/${propia.categoryId}`)
        .set(b.headers)
        .expect(404);
      expect(
        (await categorias(b.headers)).some(
          (c) => c.categoryId === propia.categoryId,
        ),
      ).toBe(false);
    });
  });

  describe('consulta de movimientos (CU-340)', () => {
    it('filtra por sentido, categoría y período; rechaza períodos inválidos', async () => {
      const a = await f.distribuidora();
      const caja = await crearCaja(a.headers, { name: 'Caja uno' });
      const ingreso = await categoriaPropia(a.headers, 'Venta', 'income');
      const gasto = await categoriaPropia(a.headers, 'Gasto', 'expense');
      await abrir(a.headers, caja.cashBoxId, 0);
      await mover(
        a.headers,
        caja.cashBoxId,
        'in',
        300,
        ingreso.categoryId,
      ).expect(201);
      await mover(
        a.headers,
        caja.cashBoxId,
        'out',
        50,
        gasto.categoryId,
      ).expect(201);

      const consulta = async (q: Record<string, string>) =>
        cuerpo<Pagina<Movimiento>>(
          await http()
            .get('/cash-movements')
            .query({ cashBoxId: caja.cashBoxId, ...q })
            .set(a.headers)
            .expect(200),
        );
      expect((await consulta({ direction: 'out' })).total).toBe(1);
      expect((await consulta({ categoryId: ingreso.categoryId })).total).toBe(
        1,
      );
      const hoy = new Date().toISOString().slice(0, 10);
      expect(
        (await consulta({ from: '2000-01-01', to: '2000-01-31' })).total,
      ).toBe(0);
      expect(
        (await consulta({ from: '2000-01-01', to: '2100-01-01' })).total,
      ).toBe(2);
      void hoy;

      await http()
        .get('/cash-movements')
        .query({ cashBoxId: caja.cashBoxId, from: '2026-13-45' })
        .set(a.headers)
        .expect(400);
      await http()
        .get('/cash-movements')
        .query({
          cashBoxId: caja.cashBoxId,
          from: '2026-10-10',
          to: '2026-10-01',
        })
        .set(a.headers)
        .expect(400);
      await http()
        .get('/cash-movements')
        .query({ cashBoxId: caja.cashBoxId, direction: 'sideways' })
        .set(a.headers)
        .expect(400);
    });
  });
});
