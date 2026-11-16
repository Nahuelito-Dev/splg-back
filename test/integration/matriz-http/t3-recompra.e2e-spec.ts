/** Matriz T3: recompra v2; las invitaciones nunca cruzan dueño ni tenant. */
import { DataSource } from 'typeorm';
import { createTestApp, TestEnv } from '../setup/test-env';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
} from './matriz';
import { EscenarioT3, sembrarBaseT3 } from './t3-base';
import {
  RepurchaseEstimateSource,
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
} from '../../../src/repurchase-forecast/entities/repurchase-invitation.entity';
import { Order, PaymentMethod } from '../../../src/order/entities/order.entity';
import { UserAddress } from '../../../src/user-address/entities/user-address.entity';
import { usarClave } from './t2-base';
import { casosEnModoSoporte } from './soporte';

describe('Matriz HTTP T3: recompra v2 (e2e)', () => {
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

  const verificarInvitacionPendiente = async (
    c: EscenarioT3,
    invitationId: string,
  ) => {
    const invitacion = await c.app
      .get(DataSource)
      .getRepository(RepurchaseInvitation)
      .findOneByOrFail({ invitationId });
    expect(invitacion).toMatchObject({
      status: RepurchaseInvitationStatus.PENDING,
      respondedAt: null,
      orderId: null,
    });
  };
  /**
   * La base admite UNA invitación pendiente por cliente y distribuidora
   * (`UQ_repurchase_invitation_abierta`): antes de abrir otra, se vencen las
   * que el cliente A tenga abiertas.
   */
  const vencerPendientesDeA = (c: EscenarioT3, salvo?: string) =>
    c.app.get(DataSource).query(
      `UPDATE repurchase_invitation SET status = 'expired', responded_at = now()
          WHERE distributor_id = $1 AND user_id = $2 AND status = 'pending'
            AND ($3::uuid IS NULL OR invitation_id <> $3::uuid)`,
      [c.distA.id, c.clienteA.userId, salvo ?? null],
    );
  /** Deja `invitationA` pendiente (y sola), para los casos que la usan después de otros que la cierran. */
  const reabrirInvitacionA = async (c: EscenarioT3) => {
    await vencerPendientesDeA(c, c.invitationA);
    await c.app.get(DataSource).query(
      `UPDATE repurchase_invitation
            SET status = 'pending', responded_at = NULL, order_id = NULL,
                expires_at = now() + interval '1 day'
          WHERE invitation_id = $1`,
      [c.invitationA],
    );
  };
  const crearInvitacionPendiente = async (c: EscenarioT3): Promise<string> => {
    await vencerPendientesDeA(c);
    const ahora = new Date();
    const invitacion = await c.app
      .get(DataSource)
      .getRepository(RepurchaseInvitation)
      .save({
        distributorId: c.distA.id,
        userId: c.clienteA.userId,
        addressId: c.addressA,
        paymentMethod: PaymentMethod.CASH,
        projectedDepletionAt: ahora,
        estimateSource: RepurchaseEstimateSource.HISTORY,
        suggestedItems: [{ gasCylinderId: c.gasCylinderA, quantity: 1 }],
        status: RepurchaseInvitationStatus.PENDING,
        expiresAt: new Date(ahora.getTime() + 24 * 60 * 60 * 1000),
        respondedAt: null,
        orderId: null,
      } as Partial<RepurchaseInvitation>);
    return invitacion.invitationId;
  };

  const mine = endpoint<EscenarioT3>(
    'get',
    '/customers/me/repurchase',
    '/v2/customers/me/repurchase',
  );
  const notice = endpoint<EscenarioT3>(
    'get',
    '/customers/me/repurchase/notice',
    '/v2/customers/me/repurchase/notice',
  );
  const invitations = endpoint<EscenarioT3>(
    'get',
    '/customers/me/repurchase/invitations',
    '/v2/customers/me/repurchase/invitations',
  );
  const invitation = endpoint<EscenarioT3>(
    'get',
    '/customers/me/repurchase/invitations/{id}',
    (c) => `/v2/customers/me/repurchase/invitations/${c.invitationA}`,
  );
  const forecast = endpoint<EscenarioT3>(
    'get',
    '/repurchase/forecast',
    '/v2/repurchase/forecast',
  );
  const customerForecast = endpoint<EscenarioT3>(
    'get',
    '/repurchase/forecast/customers/{userId}',
    (c) => `/v2/repurchase/forecast/customers/${c.clienteA.userId}`,
  );
  const adminInvitations = endpoint<EscenarioT3>(
    'get',
    '/repurchase/invitations',
    '/v2/repurchase/invitations',
  );
  const stats = endpoint<EscenarioT3>(
    'get',
    '/repurchase/stats',
    '/v2/repurchase/stats',
  );
  const reads: Array<Caso<EscenarioT3>> = [
    mine('cliente con distribuidora', 'clienteA', 200),
    mine('sin distribuidora', 'clienteA', 400, {
      cabeceras: { 'X-Distributor': null },
    }),
    mine('sin token', undefined, 401),
    mine('administrador', 'adminAConTenant', 403),
    mine('chofer', 'chofer', 403),
    notice('cliente', 'clienteA', 200),
    notice('cliente de B no recibe el aviso de A', 'clienteB', 200, {
      verificar: (b, c) =>
        expect(JSON.stringify(b)).not.toContain(c.invitationA),
    }),
    notice('sin token', undefined, 401),
    notice('administrador', 'adminAConTenant', 403),
    notice('chofer', 'chofer', 403),
    invitations('cliente', 'clienteA', 200, {
      verificar: (b, c) => {
        const texto = JSON.stringify(b);
        expect(texto).toContain(c.invitationA);
        expect(texto).not.toContain(c.invitationB);
      },
    }),
    invitations('cliente de B no ve las invitaciones de A', 'clienteB', 200, {
      verificar: (b, c) => {
        const texto = JSON.stringify(b);
        expect(texto).toContain(c.invitationB);
        expect(texto).not.toContain(c.invitationA);
      },
    }),
    invitations('sin token', undefined, 401),
    invitations('administrador', 'adminAConTenant', 403),
    invitations('chofer', 'chofer', 403),
    invitation('dueño', 'clienteA', 200),
    invitation('id mal formado', 'clienteA', 400, {
      ruta: '/v2/customers/me/repurchase/invitations/xx',
      code: 'INVALID_ID',
    }),
    invitation('sin token', undefined, 401),
    invitation('administrador', 'adminAConTenant', 403),
    invitation('chofer', 'chofer', 403),
    invitation('otro cliente', 'clienteA', 404, {
      ruta: (c) => `/v2/customers/me/repurchase/invitations/${c.invitationB}`,
    }),
    invitation('cliente de B no ve una invitación de A', 'clienteB', 404, {
      ruta: (c) => `/v2/customers/me/repurchase/invitations/${c.invitationA}`,
    }),
    invitation(
      'otro cliente de A no ve la invitación del dueño',
      'clienteA2',
      404,
      {
        ruta: (c) => `/v2/customers/me/repurchase/invitations/${c.invitationA}`,
      },
    ),
    invitation('inexistente', 'clienteA', 404, {
      ruta: (c) => `/v2/customers/me/repurchase/invitations/${c.inexistente}`,
    }),
    forecast('admin de A', 'adminAConTenant', 200, {
      verificar: (b, c) =>
        expect(JSON.stringify(b)).not.toContain(c.clienteB.userId),
    }),
    forecast('admin de B no ve el pronóstico de A', 'adminBConTenant', 200, {
      verificar: (b, c) =>
        expect(JSON.stringify(b)).not.toContain(c.clienteA.userId),
    }),
    forecast('days inválido', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast?days=0',
    }),
    forecast('days máximo excedido', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast?days=91',
    }),
    forecast('days no entero', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast?days=1.5',
    }),
    forecast('límite cero', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast?limit=0',
    }),
    forecast('límite máximo excedido', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast?limit=101',
    }),
    forecast('offset negativo', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast?offset=-1',
    }),
    forecast('campo extra', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast?inesperado=1',
    }),
    forecast('sin token', undefined, 401),
    forecast('cliente', 'clienteA', 403),
    forecast('chofer', 'chofer', 403),
    forecast('admin usa la distribuidora de su perfil', 'adminA', 200, {
      cabeceras: { 'X-Distributor': null },
    }),
    forecast(
      'super admin sin distribuidora (sin sesión de soporte)',
      'super',
      403,
      { code: 'SUPPORT_SESSION_REQUIRED' },
    ),
    customerForecast('admin de A', 'adminAConTenant', 200),
    customerForecast('id mal formado', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/forecast/customers/xx',
      code: 'INVALID_ID',
    }),
    customerForecast('sin token', undefined, 401),
    customerForecast('cliente', 'clienteA', 403),
    customerForecast('chofer', 'chofer', 403),
    customerForecast('tenant ajeno', 'adminBConTenant', 404),
    adminInvitations('admin A', 'adminAConTenant', 200, {
      verificar: (b, c) => {
        const texto = JSON.stringify(b);
        expect(texto).toContain(c.invitationA);
        expect(texto).not.toContain(c.invitationB);
      },
    }),
    adminInvitations(
      'admin B no ve las invitaciones de A',
      'adminBConTenant',
      200,
      {
        verificar: (b, c) => {
          const texto = JSON.stringify(b);
          expect(texto).toContain(c.invitationB);
          expect(texto).not.toContain(c.invitationA);
        },
      },
    ),
    adminInvitations('estado inválido', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/invitations?status=otro',
    }),
    adminInvitations('usuario inválido', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/invitations?userId=x',
    }),
    adminInvitations('desde inválido', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/invitations?from=ayer',
    }),
    adminInvitations('hasta inválido', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/invitations?to=ayer',
    }),
    adminInvitations('límite cero', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/invitations?limit=0',
    }),
    adminInvitations('offset negativo', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/invitations?offset=-1',
    }),
    adminInvitations('campo extra', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/invitations?inesperado=1',
    }),
    adminInvitations('sin token', undefined, 401),
    adminInvitations('cliente', 'clienteA', 403),
    adminInvitations('chofer', 'chofer', 403),
    stats('admin A', 'adminAConTenant', 200, {
      verificar: (b) => expect(b).toMatchObject({ sent: 1, pending: 1 }),
    }),
    stats('admin B no agrega las invitaciones de A', 'adminBConTenant', 200, {
      verificar: (b) => expect(b).toMatchObject({ sent: 1, pending: 1 }),
    }),
    stats('fecha inválida', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/stats?from=ayer',
    }),
    stats('fecha final inválida', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/stats?to=ayer',
    }),
    stats('campo extra', 'adminAConTenant', 400, {
      ruta: '/v2/repurchase/stats?inesperado=1',
    }),
    stats('sin token', undefined, 401),
    stats('cliente', 'clienteA', 403),
    stats('chofer', 'chofer', 403),
  ];
  correrMatriz('lecturas de recompra', ver, reads);

  const updateNotice = endpoint<EscenarioT3>(
    'patch',
    '/customers/me/repurchase/notice',
    '/v2/customers/me/repurchase/notice',
  );
  const accept = endpoint<EscenarioT3>(
    'post',
    '/customers/me/repurchase/invitations/{id}/accept',
    (c) => `/v2/customers/me/repurchase/invitations/${c.invitationA}/accept`,
  );
  const dismiss = endpoint<EscenarioT3>(
    'post',
    '/customers/me/repurchase/invitations/{id}/dismiss',
    (c) => `/v2/customers/me/repurchase/invitations/${c.invitationA}/dismiss`,
  );
  const run = endpoint<EscenarioT3>(
    'post',
    '/repurchase/run',
    '/v2/repurchase/run',
  );
  let invitacionAceptada: string | undefined;
  let invitacionDescartada: string | undefined;
  let direccionBorrada: string | undefined;
  let claveDeAceptacion: string | undefined;
  let invitacionConClave: string | undefined;
  const aceptarPendiente = endpoint<EscenarioT3>(
    'post',
    '/customers/me/repurchase/invitations/{id}/accept',
    () =>
      `/v2/customers/me/repurchase/invitations/${invitacionAceptada}/accept`,
  );
  const descartarPendiente = endpoint<EscenarioT3>(
    'post',
    '/customers/me/repurchase/invitations/{id}/dismiss',
    () =>
      `/v2/customers/me/repurchase/invitations/${invitacionDescartada}/dismiss`,
  );
  const aceptarConClave = endpoint<EscenarioT3>(
    'post',
    '/customers/me/repurchase/invitations/{id}/accept',
    () =>
      `/v2/customers/me/repurchase/invitations/${invitacionConClave}/accept`,
  );
  const writes: Array<Caso<EscenarioT3>> = [
    updateNotice('desactiva aviso', 'clienteA', 200, {
      body: { enabled: false },
    }),
    updateNotice('cliente de B no cambia el aviso de A', 'clienteB', 200, {
      body: { enabled: false },
      antes: async (c) => {
        const r = await llamar(
          c,
          'patch',
          '/v2/customers/me/repurchase/notice',
          'clienteA',
          { enabled: true },
        );
        expect(r.status).toBe(200);
      },
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          '/v2/customers/me/repurchase/notice',
          'clienteA',
        );
        expect(r.body).toMatchObject({ enabled: true });
      },
    }),
    updateNotice('cuerpo vacío', 'clienteA', 400, { body: {} }),
    updateNotice('días cero', 'clienteA', 400, { body: { days: 0 } }),
    updateNotice('días no enteros', 'clienteA', 400, { body: { days: 1.5 } }),
    updateNotice('días sobre el máximo', 'clienteA', 400, {
      body: { days: 31 },
    }),
    updateNotice('habilitado no booleano', 'clienteA', 400, {
      body: { enabled: 'sí' },
    }),
    updateNotice('campo extra', 'clienteA', 400, {
      body: { enabled: true, inesperado: true },
    }),
    updateNotice('sin token', undefined, 401),
    updateNotice('administrador', 'adminAConTenant', 403),
    updateNotice('chofer', 'chofer', 403),
    accept('id mal formado', 'clienteA', 400, {
      ruta: '/v2/customers/me/repurchase/invitations/xx/accept',
      body: {},
      code: 'INVALID_ID',
    }),
    accept('franja sin fecha', 'clienteA', 400, {
      body: (c) => ({ timeSlotId: c.inexistente }),
    }),
    accept('medio de pago inválido', 'clienteA', 400, {
      body: { paymentMethod: 'account' },
    }),
    accept('franja con UUID inválido', 'clienteA', 400, {
      body: { timeSlotId: 'x', scheduledDate: '2026-11-10' },
    }),
    accept('dirección con UUID inválido', 'clienteA', 400, {
      body: { addressId: 'x' },
    }),
    accept('fecha inválida', 'clienteA', 400, {
      body: { scheduledDate: 'ayer' },
    }),
    accept('notas no textuales', 'clienteA', 400, {
      body: { notes: 1 },
    }),
    accept('notas demasiado largas', 'clienteA', 400, {
      body: { notes: 'x'.repeat(501) },
    }),
    accept('campo extra', 'clienteA', 400, {
      body: { inesperado: true },
    }),
    accept('sin token', undefined, 401, { body: {} }),
    accept('administrador', 'adminAConTenant', 403, { body: {} }),
    accept('chofer', 'chofer', 403, { body: {} }),
    accept('invitación ajena', 'clienteA', 404, {
      ruta: (c) =>
        `/v2/customers/me/repurchase/invitations/${c.invitationB}/accept`,
      body: {},
    }),
    accept('cliente de B no acepta una invitación de A', 'clienteB', 404, {
      antes: reabrirInvitacionA,
      ruta: (c) =>
        `/v2/customers/me/repurchase/invitations/${c.invitationA}/accept`,
      body: {},
      verificar: async (_b, c) =>
        verificarInvitacionPendiente(c, c.invitationA),
    }),
    accept(
      'otro cliente de A no acepta la invitación del dueño',
      'clienteA2',
      404,
      {
        antes: reabrirInvitacionA,
        ruta: (c) =>
          `/v2/customers/me/repurchase/invitations/${c.invitationA}/accept`,
        body: {},
        verificar: async (_b, c) =>
          verificarInvitacionPendiente(c, c.invitationA),
      },
    ),
    accept('dirección de otro cliente', 'clienteA', 404, {
      antes: reabrirInvitacionA,
      body: (c) => ({ addressId: c.addressB }),
      mensajeExacto: 'No encontramos esa dirección entre las tuyas',
      verificar: async (_b, c) =>
        verificarInvitacionPendiente(c, c.invitationA),
    }),
    accept('dirección inexistente', 'clienteA', 404, {
      antes: reabrirInvitacionA,
      body: (c) => ({ addressId: c.inexistente }),
      mensajeExacto: 'No encontramos esa dirección entre las tuyas',
      verificar: async (_b, c) =>
        verificarInvitacionPendiente(c, c.invitationA),
    }),
    accept('dirección propia fuera de cobertura', 'clienteA', 400, {
      antes: reabrirInvitacionA,
      body: (c) => ({ addressId: c.addressAFuera }),
      mensajeExacto:
        'La dirección está fuera de la zona de cobertura de la distribuidora',
      verificar: async (_b, c) =>
        verificarInvitacionPendiente(c, c.invitationA),
    }),
    accept('dirección dada de baja lógicamente', 'clienteA', 404, {
      antes: async (c) => {
        await reabrirInvitacionA(c);
        const direcciones = c.app.get(DataSource).getRepository(UserAddress);
        const direccion = await direcciones.save({
          userId: c.clienteA.userId,
          street: 'Calle A baja 400',
          city: 'Córdoba',
          isDefault: false,
          location: { type: 'Point', coordinates: [-64.19, -31.41] },
        } as Partial<UserAddress>);
        await direcciones.softRemove(direccion);
        direccionBorrada = direccion.addressId;
      },
      body: () => ({ addressId: direccionBorrada ?? '' }),
      mensajeExacto: 'No encontramos esa dirección entre las tuyas',
      verificar: async (_b, c) =>
        verificarInvitacionPendiente(c, c.invitationA),
    }),
    aceptarPendiente('acepta la invitación y crea su pedido', 'clienteA', 201, {
      antes: async (c) => {
        invitacionAceptada = await crearInvitacionPendiente(c);
      },
      body: (c) => ({ addressId: c.addressAAlternativa }),
      verificar: async (b, c) => {
        const invitacion = await c.app
          .get(DataSource)
          .getRepository(RepurchaseInvitation)
          .findOneByOrFail({ invitationId: invitacionAceptada });
        expect(invitacion).toMatchObject({
          status: RepurchaseInvitationStatus.ACCEPTED,
        });
        const orderId = invitacion.orderId ?? '';
        expect(orderId).toEqual(expect.any(String));
        expect(JSON.stringify(b)).toContain(orderId);
        const pedido = await c.app
          .get(DataSource)
          .getRepository(Order)
          .findOneByOrFail({ orderId });
        expect(pedido.addressId).toBe(c.addressAAlternativa);
        expect(Number(pedido.zoneSurchargeAmount)).toBe(250);
        expect(Number(pedido.totalAmount)).toBe(1250);
      },
    }),
    aceptarPendiente(
      'no acepta dos veces la misma invitación',
      'clienteA',
      409,
      {
        verificar: async (_b, c) => {
          const invitacion = await c.app
            .get(DataSource)
            .getRepository(RepurchaseInvitation)
            .findOneByOrFail({ invitationId: invitacionAceptada });
          expect(invitacion.status).toBe(RepurchaseInvitationStatus.ACCEPTED);
          expect(typeof invitacion.orderId).toBe('string');
        },
      },
    ),
    dismiss('id mal formado', 'clienteA', 400, {
      ruta: '/v2/customers/me/repurchase/invitations/xx/dismiss',
      code: 'INVALID_ID',
    }),
    dismiss('sin token', undefined, 401),
    dismiss('administrador', 'adminAConTenant', 403),
    dismiss('chofer', 'chofer', 403),
    dismiss('invitación ajena', 'clienteA', 404, {
      ruta: (c) =>
        `/v2/customers/me/repurchase/invitations/${c.invitationB}/dismiss`,
    }),
    dismiss('cliente de B no descarta una invitación de A', 'clienteB', 404, {
      antes: reabrirInvitacionA,
      ruta: (c) =>
        `/v2/customers/me/repurchase/invitations/${c.invitationA}/dismiss`,
      verificar: async (_b, c) =>
        verificarInvitacionPendiente(c, c.invitationA),
    }),
    dismiss(
      'otro cliente de A no descarta la invitación del dueño',
      'clienteA2',
      404,
      {
        antes: reabrirInvitacionA,
        ruta: (c) =>
          `/v2/customers/me/repurchase/invitations/${c.invitationA}/dismiss`,
        verificar: async (_b, c) =>
          verificarInvitacionPendiente(c, c.invitationA),
      },
    ),
    descartarPendiente('descarta la invitación', 'clienteA', 200, {
      antes: async (c) => {
        invitacionDescartada = await crearInvitacionPendiente(c);
      },
      verificar: async (_b, c) => {
        const invitacion = await c.app
          .get(DataSource)
          .getRepository(RepurchaseInvitation)
          .findOneByOrFail({ invitationId: invitacionDescartada });
        expect(invitacion).toMatchObject({
          status: RepurchaseInvitationStatus.REJECTED,
        });
        expect(invitacion.respondedAt).toBeInstanceOf(Date);
      },
    }),
    descartarPendiente('no permite descartar dos veces', 'clienteA', 409),
    aceptarConClave('misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        invitacionConClave = await crearInvitacionPendiente(c);
        claveDeAceptacion = await usarClave(
          c,
          'post',
          `/v2/customers/me/repurchase/invitations/${invitacionConClave}/accept`,
          'clienteA',
          {},
        );
      },
      cabeceras: () => ({ 'Idempotency-Key': claveDeAceptacion ?? '' }),
      body: { notes: 'Otra nota' },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    run('simulación', 'adminAConTenant', 200, { body: { dryRun: true } }),
    // El proceso viene apagado (`enabled` en 0): correrlo de verdad es 409.
    run('proceso apagado', 'adminAConTenant', 409, { body: {} }),
    run('dryRun no booleano', 'adminAConTenant', 400, {
      body: { dryRun: 'sí' },
    }),
    run('campo extra', 'adminAConTenant', 400, {
      body: { dryRun: true, inesperado: true },
    }),
    run('sin token', undefined, 401, { body: { dryRun: true } }),
    run('cliente', 'clienteA', 403, { body: { dryRun: true } }),
    run('chofer', 'chofer', 403, { body: { dryRun: true } }),
    run('super admin sin distribuidora (sin sesión de soporte)', 'super', 403, {
      body: { dryRun: true },
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    run('admin usa la distribuidora de su perfil', 'adminA', 200, {
      body: { dryRun: true },
      cabeceras: { 'X-Distributor': null },
    }),
  ];
  correrMatriz('escrituras de recompra', ver, writes);
  // Modo soporte: con sesión lee lo de su empresa y no escribe; sin sesión, nada.
  correrMatriz(
    'super admin en modo soporte',
    ver,
    casosEnModoSoporte(adminInvitations, run),
  );
});
