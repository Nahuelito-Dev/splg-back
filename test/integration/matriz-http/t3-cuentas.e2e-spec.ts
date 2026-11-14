/** Matriz T3: cuentas corrientes. Los casos de B comprueban que A no se altera. */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CustomerAccount } from '../../../src/customer-account/entities/customer-account.entity';
import {
  CustomerAccountStatus,
  TaxCondition,
} from '../../../src/customer-account/domain/customer-account.enums';
import { createTestApp, TestEnv } from '../setup/test-env';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarPersona,
} from './matriz';
import { EscenarioT3, sembrarBaseT3 } from './t3-base';
import { usarClave } from './t2-base';
import { casosEnModoSoporte } from './soporte';

describe('Matriz HTTP T3: cuentas corrientes (e2e)', () => {
  let env: TestEnv;
  let ctx: EscenarioT3;
  const ver = () => ctx;
  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    ctx = {
      ...(await sembrarBaseT3(env.app)),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    ctx.actores.adminAConTenant = {
      ...ctx.actores.adminA,
      'X-Distributor': ctx.distA.slug,
    };
    ctx.actores.adminBConTenant = {
      ...ctx.actores.adminB,
      'X-Distributor': ctx.distB.slug,
    };
  }, 240000);
  afterAll(async () => env.cleanup());

  const estadoDeLaCuenta = async (c: EscenarioT3) => {
    const rows: unknown = await c.app.get(DataSource).query(
      `SELECT balance, credit_limit, (SELECT COUNT(*)::int FROM customer_account_entry
         WHERE account_id = $1) AS movements
       FROM customer_account WHERE account_id = $1`,
      [c.accountA],
    );
    expect(Array.isArray(rows)).toBe(true);
    const [cuenta] = rows as Array<{
      balance: string;
      credit_limit: string;
      movements: number;
    }>;
    return {
      balance: Number(cuenta.balance),
      creditLimit: Number(cuenta.credit_limit),
      movements: Number(cuenta.movements),
    };
  };
  /**
   * La cuenta de A queda igual que antes del intento de B: se lee en el
   * `antes` y se compara en el `verificar` (no contra un valor fijo, que
   * depende de lo que hayan hecho los casos anteriores).
   */
  const cuentaIntacta = () => {
    let previo: Awaited<ReturnType<typeof estadoDeLaCuenta>> | undefined;
    return {
      antes: async (c: EscenarioT3) => {
        previo = await estadoDeLaCuenta(c);
      },
      verificar: async (_b: unknown, c: EscenarioT3) => {
        expect(previo).toBeDefined();
        await expect(estadoDeLaCuenta(c)).resolves.toEqual(previo);
      },
    };
  };

  const listar = endpoint<EscenarioT3>(
    'get',
    '/customer-accounts',
    '/customer-accounts?limit=100',
  );
  const aging = endpoint<EscenarioT3>(
    'get',
    '/customer-accounts/aging',
    '/customer-accounts/aging',
  );
  const una = endpoint<EscenarioT3>(
    'get',
    '/customer-accounts/{id}',
    (c) => `/customer-accounts/${c.accountA}`,
  );
  const entries = endpoint<EscenarioT3>(
    'get',
    '/customer-accounts/{id}/entries',
    (c) => `/customer-accounts/${c.accountA}/entries`,
  );
  const lecturas: Array<Caso<EscenarioT3>> = [
    listar('administrador de la distribuidora', 'adminAConTenant', 200, {
      verificar: (b, c) => {
        const texto = JSON.stringify(b);
        expect(texto).toContain(c.accountA);
        expect(texto).not.toContain(c.accountB);
      },
    }),
    listar('sin token', undefined, 401),
    listar('cliente', 'clienteA', 403),
    listar('chofer', 'chofer', 403),
    listar('paginación inválida', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?limit=0',
    }),
    listar('límite no entero', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?limit=uno',
    }),
    listar('límite máximo excedido', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?limit=101',
    }),
    listar('offset negativo', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?offset=-1',
    }),
    listar('página cero', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?page=0',
    }),
    listar('estado inválido', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?status=otro',
    }),
    listar('vencida no booleana', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?overdue=talvez',
    }),
    listar('campo extra', 'adminAConTenant', 400, {
      ruta: '/customer-accounts?inesperado=1',
    }),
    aging('administrador', 'adminAConTenant', 200, {
      verificar: (b, c) => expect(JSON.stringify(b)).not.toContain(c.accountB),
    }),
    aging('sin token', undefined, 401),
    aging('cliente', 'clienteA', 403),
    aging('chofer', 'chofer', 403),
    aging(
      'super admin sin distribuidora (sin sesión de soporte)',
      'super',
      403,
      { code: 'SUPPORT_SESSION_REQUIRED' },
    ),
    una('administrador de A', 'adminAConTenant', 200),
    una('id mal formado', 'adminAConTenant', 400, {
      ruta: '/customer-accounts/xx',
      code: 'INVALID_ID',
    }),
    una('sin token', undefined, 401),
    una('cliente', 'clienteA', 403),
    una('chofer', 'chofer', 403),
    una('tenant ajeno', 'adminBConTenant', 404),
    una('inexistente', 'adminAConTenant', 404, {
      ruta: (c) => `/customer-accounts/${c.inexistente}`,
    }),
    entries('administrador de A', 'adminAConTenant', 200),
    entries('id mal formado', 'adminAConTenant', 400, {
      ruta: '/customer-accounts/xx/entries',
      code: 'INVALID_ID',
    }),
    entries('período inválido', 'adminAConTenant', 400, {
      ruta: (c) => `/customer-accounts/${c.accountA}/entries?from=ayer`,
    }),
    entries('fecha final inválida', 'adminAConTenant', 400, {
      ruta: (c) => `/customer-accounts/${c.accountA}/entries?to=ayer`,
    }),
    entries('período invertido', 'adminAConTenant', 400, {
      ruta: (c) =>
        `/customer-accounts/${c.accountA}/entries?from=2026-11-02&to=2026-11-01`,
    }),
    entries('límite máximo excedido', 'adminAConTenant', 400, {
      ruta: (c) => `/customer-accounts/${c.accountA}/entries?limit=101`,
    }),
    entries('sin token', undefined, 401),
    entries('cliente', 'clienteA', 403),
    entries('chofer', 'chofer', 403),
    entries('tenant ajeno', 'adminBConTenant', 404),
  ];
  correrMatriz('lecturas de cuenta', ver, lecturas);

  const crear = endpoint<EscenarioT3>(
    'post',
    '/customer-accounts',
    '/customer-accounts',
  );
  const editar = endpoint<EscenarioT3>(
    'patch',
    '/customer-accounts/{id}',
    (c) => `/customer-accounts/${c.accountA}`,
  );
  const pago = endpoint<EscenarioT3>(
    'post',
    '/customer-accounts/{id}/payments',
    (c) => `/customer-accounts/${c.accountA}/payments`,
  );
  const ajuste = endpoint<EscenarioT3>(
    'post',
    '/customer-accounts/{id}/adjustments',
    (c) => `/customer-accounts/${c.accountA}/adjustments`,
  );
  const alta = (c: EscenarioT3) => ({
    customerUserId: c.clienteA.userId,
    businessName: 'Nueva cuenta',
    taxCondition: 'final_consumer',
    creditLimit: 1000,
    paymentTermsDays: 30,
  });
  let cuentaNueva: string | undefined;
  let claveReutilizada: string | undefined;
  let saldoAntesDelPago: number | undefined;
  let movimientosAntesDelPago: number | undefined;
  let cajaParaPago: string | undefined;
  let cuentaCerrada: string | undefined;
  const prepararCuentaCerrada = async (c: EscenarioT3) => {
    const cliente = await sembrarPersona(
      c.app,
      'customer',
      'cliente-cuenta-cerrada',
      c.distA.id,
    );
    const cuenta = await c.app
      .get(DataSource)
      .getRepository(CustomerAccount)
      .save({
        distributorId: c.distA.id,
        customerUserId: cliente.userId,
        businessName: 'Cuenta cerrada T3',
        taxCondition: TaxCondition.FINAL_CONSUMER,
        creditLimit: 1000,
        paymentTermsDays: 30,
        status: CustomerAccountStatus.CLOSED,
        balance: 0,
      } as Partial<CustomerAccount>);
    cuentaCerrada = cuenta.accountId;
  };
  const escrituras: Array<Caso<EscenarioT3>> = [
    crear('habilita una cuenta nueva', 'adminAConTenant', 201, {
      body: (c) => ({ ...alta(c), customerUserId: c.clienteA2.userId }),
      verificar: async (b, c) => {
        const id = (b as { accountId: string }).accountId;
        expect(id).toEqual(expect.any(String));
        const leida = await llamar(
          c,
          'get',
          `/customer-accounts/${id}`,
          'adminAConTenant',
        );
        expect(leida.status).toBe(200);
        expect(leida.body).toMatchObject({
          customerUserId: c.clienteA2.userId,
        });
      },
    }),
    crear('cliente ya tiene cuenta', 'adminAConTenant', 409, { body: alta }),
    crear('cliente inexistente', 'adminAConTenant', 404, {
      body: (c) => ({ ...alta(c), customerUserId: c.inexistente }),
    }),
    crear('sin cliente', 'adminAConTenant', 400, {
      body: {
        businessName: 'X',
        taxCondition: 'consumer',
        creditLimit: 0,
        paymentTermsDays: 1,
      },
    }),
    crear('sin razón social', 'adminAConTenant', 400, {
      body: (c) => {
        const { businessName, ...sinCampo } = alta(c);
        void businessName;
        return sinCampo;
      },
    }),
    crear('sin condición fiscal', 'adminAConTenant', 400, {
      body: (c) => {
        const { taxCondition, ...sinCampo } = alta(c);
        void taxCondition;
        return sinCampo;
      },
    }),
    crear('sin límite de crédito', 'adminAConTenant', 400, {
      body: (c) => {
        const { creditLimit, ...sinCampo } = alta(c);
        void creditLimit;
        return sinCampo;
      },
    }),
    crear('sin plazo', 'adminAConTenant', 400, {
      body: (c) => {
        const { paymentTermsDays, ...sinCampo } = alta(c);
        void paymentTermsDays;
        return sinCampo;
      },
    }),
    crear('CUIT inválido', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), taxId: '123' }),
    }),
    crear('razón social vacía', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), businessName: '   ' }),
    }),
    crear('razón social demasiado larga', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), businessName: 'x'.repeat(121) }),
    }),
    crear('condición fiscal inválida', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), taxCondition: 'otra' }),
    }),
    crear('límite negativo', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), creditLimit: -1 }),
    }),
    crear('límite sobre el máximo', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), creditLimit: 10_000_000_000 }),
    }),
    crear('plazo cero', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), paymentTermsDays: 0 }),
    }),
    crear('plazo mayor a 365', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), paymentTermsDays: 366 }),
    }),
    crear('plazo decimal', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), paymentTermsDays: 1.5 }),
    }),
    crear('cliente con UUID inválido', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), customerUserId: 'x' }),
    }),
    crear('campo extra', 'adminAConTenant', 400, {
      body: (c) => ({ ...alta(c), inesperado: true }),
    }),
    crear('sin token', undefined, 401),
    crear('cliente', 'clienteA', 403),
    crear('chofer', 'chofer', 403),
    editar('modifica límite', 'adminAConTenant', 200, {
      body: { creditLimit: 12000 },
      verificar: (b) => expect(b).toMatchObject({ creditLimit: 12000 }),
    }),
    editar('límite negativo', 'adminAConTenant', 400, {
      body: { creditLimit: -1 },
    }),
    editar('límite sobre el máximo', 'adminAConTenant', 400, {
      body: { creditLimit: 10_000_000_000 },
    }),
    editar('plazo cero', 'adminAConTenant', 400, {
      body: { paymentTermsDays: 0 },
    }),
    editar('plazo decimal', 'adminAConTenant', 400, {
      body: { paymentTermsDays: 1.5 },
    }),
    editar('razón social vacía', 'adminAConTenant', 400, {
      body: { businessName: ' ' },
    }),
    editar('razón social demasiado larga', 'adminAConTenant', 400, {
      body: { businessName: 'x'.repeat(121) },
    }),
    editar('CUIT inválido', 'adminAConTenant', 400, {
      body: { taxId: '123' },
    }),
    editar('condición fiscal inválida', 'adminAConTenant', 400, {
      body: { taxCondition: 'otra' },
    }),
    editar('plazo mayor a 365', 'adminAConTenant', 400, {
      body: { paymentTermsDays: 366 },
    }),
    editar('estado inválido', 'adminAConTenant', 400, {
      body: { status: 'otro' },
    }),
    editar('campo extra', 'adminAConTenant', 400, {
      body: { inesperado: true },
    }),
    editar('id mal formado', 'adminAConTenant', 400, {
      ruta: '/customer-accounts/xx',
      body: { creditLimit: 1 },
      code: 'INVALID_ID',
    }),
    editar('sin token', undefined, 401),
    editar('cliente', 'clienteA', 403),
    editar('chofer', 'chofer', 403),
    editar('tenant ajeno queda intacto', 'adminBConTenant', 404, {
      body: { creditLimit: 1 },
      ...cuentaIntacta(),
    }),
    pago('asienta el cobro y reduce el saldo', 'adminAConTenant', 201, {
      antes: async (c) => {
        const cargo = await llamar(
          c,
          'post',
          `/customer-accounts/${c.accountA}/adjustments`,
          'adminAConTenant',
          { kind: 'debit', amount: 100, reason: 'Deuda para probar cobro' },
        );
        expect(cargo.status).toBe(201);
        const caja = await llamar(c, 'post', '/cash-boxes', 'adminAConTenant', {
          name: `Caja cobros ${randomUUID().slice(0, 6)}`,
          kind: 'cash',
          requiresSession: true,
        });
        expect(caja.status).toBe(201);
        cajaParaPago = (caja.body as { cashBoxId: string }).cashBoxId;
        const sesion = await llamar(
          c,
          'post',
          `/cash-boxes/${cajaParaPago}/sessions`,
          'adminAConTenant',
          { openingAmount: 0 },
        );
        expect(sesion.status).toBe(201);
        const estado = await estadoDeLaCuenta(c);
        saldoAntesDelPago = estado.balance;
        movimientosAntesDelPago = estado.movements;
      },
      body: () => ({ amount: 40, method: 'cash', cashBoxId: cajaParaPago }),
      verificar: async (_b, c) => {
        const estado = await estadoDeLaCuenta(c);
        expect(estado.balance).toBe((saldoAntesDelPago ?? 0) - 40);
        expect(estado.movements).toBe((movimientosAntesDelPago ?? 0) + 1);
      },
    }),
    pago('importe no positivo', 'adminAConTenant', 400, {
      body: { amount: 0, method: 'cash' },
    }),
    pago('sin importe', 'adminAConTenant', 400, {
      body: { method: 'cash' },
    }),
    pago('sin medio', 'adminAConTenant', 400, {
      body: { amount: 1 },
    }),
    pago('importe sobre el máximo', 'adminAConTenant', 400, {
      body: { amount: 10_000_000_000, method: 'cash' },
    }),
    pago('medio inválido', 'adminAConTenant', 400, {
      body: { amount: 1, method: 'bitcoin' },
    }),
    pago('importe decimal inválido', 'adminAConTenant', 400, {
      body: { amount: 1.234, method: 'cash' },
    }),
    pago('caja con UUID inválido', 'adminAConTenant', 400, {
      body: { amount: 1, method: 'cash', cashBoxId: 'x' },
    }),
    pago('descripción vacía', 'adminAConTenant', 400, {
      body: { amount: 1, method: 'cash', description: ' ' },
    }),
    pago('descripción demasiado larga', 'adminAConTenant', 400, {
      body: { amount: 1, method: 'cash', description: 'x'.repeat(256) },
    }),
    pago('campo extra', 'adminAConTenant', 400, {
      body: { amount: 1, method: 'cash', inesperado: true },
    }),
    pago('id mal formado', 'adminAConTenant', 400, {
      ruta: '/customer-accounts/xx/payments',
      body: { amount: 1, method: 'cash' },
      code: 'INVALID_ID',
    }),
    pago('sin token', undefined, 401),
    pago('cliente', 'clienteA', 403),
    pago('chofer sin rendición', 'chofer', 409, {
      body: { amount: 1, method: 'cash' },
    }),
    pago('tenant ajeno', 'adminBConTenant', 404, {
      body: { amount: 1, method: 'cash' },
      ...cuentaIntacta(),
    }),
    ajuste('nota de débito aumenta el saldo', 'adminAConTenant', 201, {
      antes: async (c) => {
        const estado = await estadoDeLaCuenta(c);
        saldoAntesDelPago = estado.balance;
        movimientosAntesDelPago = estado.movements;
      },
      body: { kind: 'debit', amount: 25, reason: 'Corrección de saldo' },
      verificar: async (_b, c) => {
        const estado = await estadoDeLaCuenta(c);
        expect(estado.balance).toBe((saldoAntesDelPago ?? 0) + 25);
        expect(estado.movements).toBe((movimientosAntesDelPago ?? 0) + 1);
      },
    }),
    ajuste('tipo inválido', 'adminAConTenant', 400, {
      body: { kind: 'otro', amount: 1, reason: 'Corrección' },
    }),
    ajuste('sin tipo', 'adminAConTenant', 400, {
      body: { amount: 1, reason: 'Corrección' },
    }),
    ajuste('sin importe', 'adminAConTenant', 400, {
      body: { kind: 'credit', reason: 'Corrección' },
    }),
    ajuste('importe sobre el máximo', 'adminAConTenant', 400, {
      body: { kind: 'credit', amount: 10_000_000_000, reason: 'Corrección' },
    }),
    ajuste('importe no positivo', 'adminAConTenant', 400, {
      body: { kind: 'credit', amount: 0, reason: 'Corrección' },
    }),
    ajuste('sin motivo', 'adminAConTenant', 400, {
      body: { kind: 'credit', amount: 1 },
    }),
    ajuste('motivo vacío', 'adminAConTenant', 400, {
      body: { kind: 'credit', amount: 1, reason: ' ' },
    }),
    ajuste('motivo demasiado largo', 'adminAConTenant', 400, {
      body: { kind: 'credit', amount: 1, reason: 'x'.repeat(256) },
    }),
    ajuste('importe decimal inválido', 'adminAConTenant', 400, {
      body: { kind: 'credit', amount: 1.234, reason: 'Corrección' },
    }),
    ajuste('campo extra', 'adminAConTenant', 400, {
      body: {
        kind: 'credit',
        amount: 1,
        reason: 'Corrección',
        inesperado: true,
      },
    }),
    ajuste('id mal formado', 'adminAConTenant', 400, {
      ruta: '/customer-accounts/xx/adjustments',
      body: { kind: 'credit', amount: 1, reason: 'X' },
      code: 'INVALID_ID',
    }),
    ajuste('sin token', undefined, 401),
    ajuste('cliente', 'clienteA', 403),
    ajuste('chofer', 'chofer', 403),
    ajuste('tenant ajeno', 'adminBConTenant', 404, {
      body: { kind: 'credit', amount: 1, reason: 'X' },
      ...cuentaIntacta(),
    }),
    editar('misma clave con otro cuerpo', 'adminAConTenant', 422, {
      antes: async (c) => {
        claveReutilizada = await usarClave(
          c,
          'patch',
          `/customer-accounts/${c.accountA}`,
          'adminAConTenant',
          { creditLimit: 12001 },
        );
      },
      cabeceras: () => ({ 'Idempotency-Key': claveReutilizada ?? '' }),
      body: { creditLimit: 12002 },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    ajuste('misma clave con otro cuerpo', 'adminAConTenant', 422, {
      antes: async (c) => {
        claveReutilizada = await usarClave(
          c,
          'post',
          `/customer-accounts/${c.accountA}/adjustments`,
          'adminAConTenant',
          { kind: 'debit', amount: 1, reason: 'Clave inicial' },
        );
      },
      cabeceras: () => ({ 'Idempotency-Key': claveReutilizada ?? '' }),
      body: { kind: 'debit', amount: 2, reason: 'Otro cuerpo' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    pago('misma clave con otro cuerpo', 'adminAConTenant', 422, {
      antes: async (c) => {
        claveReutilizada = await usarClave(
          c,
          'post',
          `/customer-accounts/${c.accountA}/payments`,
          'adminAConTenant',
          { amount: 1, method: 'cash', cashBoxId: cajaParaPago },
        );
      },
      cabeceras: () => ({ 'Idempotency-Key': claveReutilizada ?? '' }),
      body: () => ({ amount: 2, method: 'cash', cashBoxId: cajaParaPago }),
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    crear('misma clave con otro cuerpo', 'adminAConTenant', 422, {
      antes: async (c) => {
        const cliente = await sembrarPersona(
          c.app,
          'customer',
          'cliente-clave-cuenta',
          c.distA.id,
        );
        cuentaNueva = cliente.userId;
        claveReutilizada = await usarClave(
          c,
          'post',
          '/customer-accounts',
          'adminAConTenant',
          {
            ...alta(c),
            customerUserId: cuentaNueva,
          },
        );
      },
      cabeceras: () => ({ 'Idempotency-Key': claveReutilizada ?? '' }),
      body: (c) => ({ ...alta(c), customerUserId: c.clienteA.userId }),
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    // Cerrada → bloqueada no existe (hay que reabrirla); cerrada → cerrada no
    // hace nada y responde 200 (`exigirTransicionDeCuenta`).
    editar('cuenta cerrada no admite la transición', 'adminAConTenant', 409, {
      antes: prepararCuentaCerrada,
      ruta: () => `/customer-accounts/${cuentaCerrada}`,
      body: { status: 'blocked' },
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/customer-accounts/${cuentaCerrada}`,
          'adminAConTenant',
        );
        expect(r.body).toMatchObject({ status: 'closed' });
      },
    }),
    ajuste('cuenta cerrada', 'adminAConTenant', 409, {
      antes: prepararCuentaCerrada,
      ruta: () => `/customer-accounts/${cuentaCerrada}/adjustments`,
      body: { kind: 'debit', amount: 1, reason: 'No debe asentarse' },
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/customer-accounts/${cuentaCerrada}/entries`,
          'adminAConTenant',
        );
        expect(r.body).toMatchObject({ data: [], total: 0 });
      },
    }),
  ];
  correrMatriz('escrituras de cuenta', ver, escrituras);
  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    ver,
    casosEnModoSoporte(listar, crear),
  );
});
