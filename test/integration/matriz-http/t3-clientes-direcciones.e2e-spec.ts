/** Matriz T3: clientes y direcciones; los escritos ajenos se releen intactos. */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { Customer } from '../../../src/customer/entities/customer.entity';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Role } from '../../../src/role/entities/role.entity';
import { User } from '../../../src/users/entities/user.entity';
import { createTestApp, telefonoDePrueba, TestEnv } from '../setup/test-env';
import {
  Caso,
  correrMatriz,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  cabecerasDe_,
} from './matriz';
import { EscenarioT3, sembrarBaseT3 } from './t3-base';
import { usarClave } from './t2-base';

describe('Matriz HTTP T3: clientes y direcciones (e2e)', () => {
  let env: TestEnv;
  let ctx: EscenarioT3;
  const ver = () => ctx;
  const prepararClienteSinFicha = async (c: EscenarioT3, etiqueta: string) => {
    const role = await c.app
      .get(DataSource)
      .getRepository(Role)
      .findOneByOrFail({ type: RoleType.CUSTOMER });
    const email = `${etiqueta}.${randomUUID().slice(0, 6)}@splg.local`;
    await c.app
      .get(DataSource)
      .getRepository(User)
      .save({
        email,
        fullName: 'Cliente sin ficha',
        phoneNumber: telefonoDePrueba(),
        firebaseUid: `uid-${email}`,
        roleId: role.roleId,
      } as Partial<User>);
    c.actores.clienteSinFicha = cabecerasDe_(
      email,
      'customer-app',
      c.distA.slug,
    );
  };

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    ctx = {
      ...(await sembrarBaseT3(env.app)),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    ctx.actores.superEnA = {
      ...ctx.actores.super,
      'X-Distributor': ctx.distA.slug,
    };
    ctx.actores.superEnB = {
      ...ctx.actores.super,
      'X-Distributor': ctx.distB.slug,
    };
  }, 240000);
  afterAll(async () => env.cleanup());

  const customer = endpoint<EscenarioT3>(
    'get',
    '/customers/{id}',
    (c) => `/customers/${c.customerA}`,
  );
  const customerByUser = endpoint<EscenarioT3>(
    'get',
    '/customers/user/{userId}',
    (c) => `/customers/user/${c.clienteA.userId}`,
  );
  const address = endpoint<EscenarioT3>(
    'get',
    '/user-address/{id}',
    (c) => `/user-address/${c.addressA}`,
  );
  const addressByUser = endpoint<EscenarioT3>(
    'get',
    '/user-address/user/{userId}',
    (c) => `/user-address/user/${c.clienteA.userId}`,
  );
  const addressDefault = endpoint<EscenarioT3>(
    'get',
    '/user-address/user/{userId}/default',
    (c) => `/user-address/user/${c.clienteA.userId}/default`,
  );
  const listCustomers = endpoint<EscenarioT3>(
    'get',
    '/customers',
    '/customers?limit=100',
  );
  const listAddresses = endpoint<EscenarioT3>(
    'get',
    '/user-address',
    '/user-address?limit=100',
  );
  const removedCustomers = endpoint<EscenarioT3>(
    'get',
    '/customers/removed',
    '/v2/customers/removed?limit=100',
  );
  const cases: Array<Caso<EscenarioT3>> = [
    listCustomers('administrador de A', 'adminA', 200, {
      verificar: (b, c) => {
        const texto = JSON.stringify(b);
        expect(texto).toContain(c.clienteA.email);
        expect(texto).not.toContain(c.clienteB.email);
      },
    }),
    listCustomers('sin token', undefined, 401),
    listCustomers('cliente', 'clienteA', 403),
    listCustomers('chofer', 'chofer', 403),
    listCustomers('super admin', 'super', 200),
    listCustomers('límite no entero', 'adminA', 400, {
      ruta: '/customers?limit=uno',
    }),
    listCustomers('límite máximo excedido', 'adminA', 400, {
      ruta: '/customers?limit=101',
    }),
    listCustomers('offset negativo', 'adminA', 400, {
      ruta: '/customers?offset=-1',
    }),
    listCustomers('página cero', 'adminA', 400, {
      ruta: '/customers?page=0',
    }),
    listCustomers('estado inválido', 'adminA', 400, {
      ruta: '/customers?status=deleted',
    }),
    listCustomers('campo de consulta extra', 'adminA', 400, {
      ruta: '/customers?ajeno=1',
    }),
    removedCustomers('administrador de A', 'adminA', 200, {
      verificar: (b, c) =>
        expect(JSON.stringify(b)).not.toContain(c.clienteB.email),
    }),
    removedCustomers('sin token', undefined, 401),
    removedCustomers('cliente', 'clienteA', 403),
    removedCustomers('chofer', 'chofer', 403),
    customer('cliente propio', 'clienteA', 200),
    customer('id mal formado', 'clienteA', 400, {
      ruta: '/customers/xx',
      code: 'INVALID_ID',
    }),
    customer('sin token', undefined, 401),
    customer('otro cliente de la misma distribuidora', 'clienteA', 403, {
      ruta: (c) => `/customers/${c.customerB}`,
    }),
    customer('tenant ajeno', 'adminB', 404),
    customer('inexistente', 'adminA', 404, {
      ruta: (c) => `/customers/${c.inexistente}`,
    }),
    customerByUser('administrador A', 'adminA', 200),
    customerByUser('id mal formado', 'adminA', 400, {
      ruta: '/customers/user/xx',
      code: 'INVALID_ID',
    }),
    customerByUser('sin token', undefined, 401),
    customerByUser('otro cliente', 'clienteA', 403, {
      ruta: (c) => `/customers/user/${c.clienteB.userId}`,
    }),
    customerByUser('tenant ajeno', 'adminB', 404),
    listAddresses('administrador general', 'super', 200),
    listAddresses('sin token', undefined, 401),
    listAddresses('cliente', 'clienteA', 403),
    listAddresses('administrador', 'adminA', 403),
    listAddresses('chofer', 'chofer', 403),
    listAddresses('límite inválido', 'super', 400, {
      ruta: '/user-address?limit=0',
    }),
    listAddresses('límite máximo excedido', 'super', 400, {
      ruta: '/user-address?limit=101',
    }),
    listAddresses('offset negativo', 'super', 400, {
      ruta: '/user-address?offset=-1',
    }),
    listAddresses('página no entera', 'super', 400, {
      ruta: '/user-address?page=uno',
    }),
    address('dueño', 'clienteA', 200),
    address('id mal formado', 'clienteA', 400, {
      ruta: '/user-address/xx',
      code: 'INVALID_ID',
    }),
    address('sin token', undefined, 401),
    address('otro dueño', 'clienteA', 403, {
      ruta: (c) => `/user-address/${c.addressB}`,
    }),
    address('tenant ajeno', 'adminB', 404),
    addressByUser('dueño', 'clienteA', 200, {
      verificar: (b, c) => {
        const texto = JSON.stringify(b);
        expect(texto).toContain(c.addressA);
        expect(texto).not.toContain(c.addressB);
      },
    }),
    addressByUser('id mal formado', 'clienteA', 400, {
      ruta: '/user-address/user/xx',
      code: 'INVALID_ID',
    }),
    addressByUser('sin token', undefined, 401),
    addressByUser('otro dueño', 'clienteA', 403, {
      ruta: (c) => `/user-address/user/${c.clienteB.userId}`,
    }),
    addressByUser('tenant ajeno', 'adminB', 404),
    addressDefault('dueño', 'clienteA', 200),
    addressDefault('id mal formado', 'clienteA', 400, {
      ruta: '/user-address/user/xx/default',
      code: 'INVALID_ID',
    }),
    addressDefault('sin token', undefined, 401),
    addressDefault('otro dueño', 'clienteA', 403, {
      ruta: (c) => `/user-address/user/${c.clienteB.userId}/default`,
    }),
    addressDefault('sin dirección principal', 'clienteA2', 404, {
      ruta: (c) => `/user-address/user/${c.clienteA2.userId}/default`,
    }),
  ];
  correrMatriz('lecturas', ver, cases);

  const consumo = endpoint<EscenarioT3>(
    'get',
    '/customers/me/consumption',
    '/customers/me/consumption',
  );
  const cambiarConsumo = endpoint<EscenarioT3>(
    'patch',
    '/customers/me/consumption',
    '/customers/me/consumption',
  );
  correrMatriz('consumo declarado', ver, [
    consumo('cliente', 'clienteA', 200),
    consumo('sin token', undefined, 401),
    consumo('administrador', 'adminA', 403),
    consumo('chofer', 'chofer', 403),
    consumo('cliente sin ficha', 'clienteSinFicha', 404, {
      antes: (c) => prepararClienteSinFicha(c, 'sin-ficha-get'),
    }),
    cambiarConsumo('tipo inexistente', 'clienteA', 400, {
      body: (c) => ({ cylinderTypeId: c.inexistente }),
    }),
    cambiarConsumo('cantidad negativa', 'clienteA', 400, {
      body: { quantityPerMonth: -1 },
    }),
    cambiarConsumo('tipo con formato inválido', 'clienteA', 400, {
      body: { cylinderTypeId: 'no-uuid' },
    }),
    cambiarConsumo('cantidad cero', 'clienteA', 400, {
      body: { quantityPerMonth: 0 },
    }),
    cambiarConsumo('cantidad sobre el máximo', 'clienteA', 400, {
      body: { quantityPerMonth: 1001 },
    }),
    cambiarConsumo('cantidad con tres decimales', 'clienteA', 400, {
      body: { quantityPerMonth: 1.234 },
    }),
    cambiarConsumo('confirmación no booleana', 'clienteA', 400, {
      body: { quantityPerMonth: 1, confirmOutOfRange: 'sí' },
    }),
    cambiarConsumo('campo extra', 'clienteA', 400, {
      body: { quantityPerMonth: 1, inesperado: true },
    }),
    cambiarConsumo('sin token', undefined, 401, { body: {} }),
    cambiarConsumo('administrador', 'adminA', 403, { body: {} }),
    cambiarConsumo('chofer', 'chofer', 403, { body: {} }),
    cambiarConsumo('cliente sin ficha', 'clienteSinFicha', 404, {
      antes: (c) => prepararClienteSinFicha(c, 'sin-ficha-patch'),
      body: (c) => ({ cylinderTypeId: c.gasCylinderA }),
    }),
    cambiarConsumo('guarda el consumo declarado', 'clienteA', 200, {
      body: (c) => ({ cylinderTypeId: c.gasCylinderA, quantityPerMonth: 2 }),
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          '/customers/me/consumption',
          'clienteA',
        );
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          cylinderTypeId: c.gasCylinderA,
          avgMonthlyConsumptionKg: 20,
        });
      },
    }),
  ]);

  const crearDireccion = endpoint<EscenarioT3>(
    'post',
    '/user-address',
    '/user-address',
  );
  const editarDireccion = endpoint<EscenarioT3>(
    'patch',
    '/user-address/{id}',
    (c) => `/user-address/${c.addressA}`,
  );
  const principal = endpoint<EscenarioT3>(
    'patch',
    '/user-address/{id}/set-default',
    (c) => `/user-address/${c.addressA}`,
  );
  const borrar = endpoint<EscenarioT3>(
    'delete',
    '/user-address/{id}',
    (c) => `/user-address/${c.addressA}`,
  );
  const editarCliente = endpoint<EscenarioT3>(
    'patch',
    '/customers/{id}',
    (c) => `/customers/${c.customerA}`,
  );
  const ubicacionCliente = endpoint<EscenarioT3>(
    'patch',
    '/customers/{id}/location',
    (c) => `/customers/${c.customerA}/location`,
  );
  const bajaCliente = endpoint<EscenarioT3>(
    'delete',
    '/customers/{id}',
    (c) => `/customers/${c.customerA}`,
  );
  const bajaPorDistribuidora = endpoint<EscenarioT3>(
    'delete',
    '/customers/{id}/distributor',
    (c) => `/v2/customers/${c.customerA}/distributor`,
  );
  const restaurarPorDistribuidora = endpoint<EscenarioT3>(
    'post',
    '/customers/{id}/distributor',
    (c) => `/v2/customers/${c.customerA}/distributor`,
  );
  let direccionDeBaja = '';
  let pedidoEnCurso = '';
  const mutaciones: Array<Caso<EscenarioT3>> = [
    crearDireccion('cliente crea la propia', 'clienteA', 201, {
      body: {
        street: 'Nueva 1',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
      },
      verificar: async (b, c) => {
        const id = (b as { address_id: string }).address_id;
        const r = await llamar(c, 'get', `/user-address/${id}`, 'clienteA');
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ street: 'Nueva 1', city: 'Córdoba' });
      },
    }),
    crearDireccion('sin calle', 'clienteA', 400, {
      body: { city: 'Córdoba', latitude: '-31.4', longitude: '-64.2' },
    }),
    crearDireccion('latitud inválida', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: 'x',
        longitude: '-64.2',
      },
    }),
    crearDireccion('sin ciudad', 'clienteA', 400, {
      body: { street: 'Nueva', latitude: '-31.4', longitude: '-64.2' },
    }),
    crearDireccion('sin longitud', 'clienteA', 400, {
      body: { street: 'Nueva', city: 'Córdoba', latitude: '-31.4' },
    }),
    crearDireccion('calle no textual', 'clienteA', 400, {
      body: {
        street: 1,
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
      },
    }),
    crearDireccion('longitud inválida', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: 'x',
      },
    }),
    crearDireccion('piso demasiado largo', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
        floor: '12345678901',
      },
    }),
    crearDireccion('departamento demasiado largo', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
        apartment: '12345678901',
      },
    }),
    crearDireccion('placeId demasiado largo', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
        placeId: 'x'.repeat(256),
      },
    }),
    crearDireccion('precisión inválida', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
        geocodePrecision: 'otra',
      },
    }),
    crearDireccion('principal no booleana', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
        isDefault: 'sí',
      },
    }),
    crearDireccion('campo extra', 'clienteA', 400, {
      body: {
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
        inesperado: true,
      },
    }),
    crearDireccion('sin token', undefined, 401),
    crearDireccion('misma clave con otro cuerpo', 'clienteA', 422, {
      antes: async (c) => {
        const clave = await usarClave(c, 'post', '/user-address', 'clienteA', {
          street: 'Clave inicial',
          city: 'Córdoba',
          latitude: '-31.4',
          longitude: '-64.2',
        });
        c.actores.claveDireccion = { 'Idempotency-Key': clave };
      },
      cabeceras: (c) => c.actores.claveDireccion,
      body: {
        street: 'Otro cuerpo',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
      },
      code: 'IDEMPOTENCY_KEY_REUSED',
    }),
    crearDireccion('usuario inexistente', 'super', 404, {
      body: (c) => ({
        user_id: c.inexistente,
        street: 'Nueva',
        city: 'Córdoba',
        latitude: '-31.4',
        longitude: '-64.2',
      }),
    }),
    editarDireccion('cambia ciudad', 'clienteA', 200, {
      body: { city: 'Villa Carlos Paz' },
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/user-address/${c.addressA}`,
          'clienteA',
        );
        expect(r.body).toMatchObject({ city: 'Villa Carlos Paz' });
      },
    }),
    editarDireccion('campo de dueño no modificable', 'clienteA', 400, {
      body: (c) => ({ user_id: c.clienteB.userId }),
    }),
    editarDireccion('latitud sin longitud', 'clienteA', 400, {
      body: { latitude: '-31.4' },
    }),
    editarDireccion('longitud sin latitud', 'clienteA', 400, {
      body: { longitude: '-64.2' },
    }),
    editarDireccion('piso demasiado largo', 'clienteA', 400, {
      body: { floor: '12345678901' },
    }),
    editarDireccion('precisión inválida', 'clienteA', 400, {
      body: { geocodePrecision: 'otra' },
    }),
    editarDireccion('principal no booleana', 'clienteA', 400, {
      body: { isDefault: 'sí' },
    }),
    editarDireccion('id mal formado', 'clienteA', 400, {
      ruta: '/user-address/xx',
      body: { city: 'X' },
      code: 'INVALID_ID',
    }),
    editarDireccion('sin token', undefined, 401),
    editarDireccion('dirección inexistente', 'clienteA', 404, {
      ruta: (c) => `/user-address/${c.inexistente}`,
      body: { city: 'X' },
    }),
    editarDireccion('dueño ajeno queda intacto', 'clienteA', 403, {
      ruta: (c) => `/user-address/${c.addressB}`,
      body: { city: 'No cambiar' },
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/user-address/${c.addressB}`,
          'clienteB',
        );
        expect((r.body as unknown as { city: string }).city).toBe('Córdoba');
      },
    }),
    principal('la marca principal', 'clienteA', 200, {
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/user-address/${c.addressA}`,
          'clienteA',
        );
        expect(r.body).toMatchObject({ isDefault: true });
      },
    }),
    principal('id mal formado', 'clienteA', 400, {
      ruta: '/user-address/xx',
      code: 'INVALID_ID',
    }),
    principal('sin token', undefined, 401),
    principal('dueño ajeno', 'clienteA', 403, {
      ruta: (c) => `/user-address/${c.addressB}/set-default`,
    }),
    principal('dirección inexistente', 'clienteA', 404, {
      ruta: (c) => `/user-address/${c.inexistente}/set-default`,
    }),
    borrar('id mal formado', 'clienteA', 400, {
      ruta: '/user-address/xx',
      code: 'INVALID_ID',
    }),
    borrar('sin token', undefined, 401),
    borrar('dueño ajeno', 'clienteA', 403, {
      ruta: (c) => `/user-address/${c.addressB}`,
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/user-address/${c.addressB}`,
          'clienteB',
        );
        expect(r.status).toBe(200);
      },
    }),
    borrar('tenant ajeno queda intacto', 'adminB', 404, {
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/user-address/${c.addressA}`,
          'clienteA',
        );
        expect(r.status).toBe(200);
      },
    }),
    // Con una dirección propia del caso: la compartida (`addressA`) la usan
    // los casos que vienen después (pedidos, baja por distribuidora).
    borrar('cliente da de baja lógicamente su dirección', 'clienteA', 200, {
      antes: async (c) => {
        const r = await llamar(c, 'post', '/user-address', 'clienteA', {
          street: 'Para dar de baja 1',
          city: 'Córdoba',
          latitude: '-31.41',
          longitude: '-64.21',
        });
        expect(r.status).toBe(201);
        direccionDeBaja = (r.body as { address_id: string }).address_id;
      },
      ruta: () => `/user-address/${direccionDeBaja}`,
      verificar: async (_b, c) => {
        const r = await llamar(
          c,
          'get',
          `/user-address/${direccionDeBaja}`,
          'clienteA',
        );
        expect(r.status).toBe(404);
        const compartida = await llamar(
          c,
          'get',
          `/user-address/${c.addressA}`,
          'clienteA',
        );
        expect(compartida.status).toBe(200);
      },
    }),
    editarCliente('cliente actualiza su ficha', 'clienteA', 200, {
      body: { notification_token: 'otro-token' },
      verificar: async (_b, c) => {
        const cliente = await c.app
          .get(DataSource)
          .getRepository(Customer)
          .findOneByOrFail({ customerId: c.customerA });
        expect(cliente.notificationToken).toBe('otro-token');
      },
    }),
    editarCliente('dato desconocido', 'clienteA', 400, {
      body: { user_id: 'x' },
    }),
    editarCliente('token no textual', 'clienteA', 400, {
      body: { notification_token: 1 },
    }),
    editarCliente('ubicación inválida', 'clienteA', 400, {
      body: { lat_lang: 'x' },
    }),
    editarCliente('id mal formado', 'clienteA', 400, {
      ruta: '/customers/xx',
      body: {},
      code: 'INVALID_ID',
    }),
    editarCliente('sin token', undefined, 401, { body: {} }),
    editarCliente('otro cliente', 'clienteA', 403, {
      ruta: (c) => `/customers/${c.customerB}`,
      body: {},
    }),
    editarCliente('tenant ajeno', 'adminB', 404, { body: {} }),
    ubicacionCliente('cliente actualiza ubicación', 'clienteA', 200, {
      body: { latLng: '-31.4,-64.2' },
      verificar: (b) => expect(JSON.stringify(b)).toContain('-31.4'),
    }),
    ubicacionCliente('coordenadas inválidas', 'clienteA', 400, {
      body: { latLng: 'x' },
    }),
    ubicacionCliente('sin coordenadas', 'clienteA', 400, { body: {} }),
    ubicacionCliente('campo extra', 'clienteA', 400, {
      body: { latLng: '-31.4,-64.2', inesperado: true },
    }),
    ubicacionCliente('id mal formado', 'clienteA', 400, {
      ruta: '/customers/xx/location',
      // Body válido: el 400 tiene que venir del id, no del DTO.
      body: { latLng: '-31.4,-64.2' },
      code: 'INVALID_ID',
    }),
    ubicacionCliente('sin token', undefined, 401, { body: {} }),
    ubicacionCliente('otro cliente', 'clienteA', 403, {
      ruta: (c) => `/customers/${c.customerB}/location`,
      body: { latLng: '-31.4,-64.2' },
    }),
    ubicacionCliente('cliente inexistente', 'adminA', 404, {
      ruta: (c) => `/customers/${c.inexistente}/location`,
      body: { latLng: '-31.4,-64.2' },
    }),
    bajaCliente('id mal formado', 'superEnA', 400, {
      ruta: '/customers/xx',
      code: 'INVALID_ID',
    }),
    bajaCliente('super admin sin distribuidora', 'super', 400, {
      code: 'MISSING_DISTRIBUTOR',
    }),
    bajaCliente('sin token', undefined, 401),
    bajaCliente('cliente', 'clienteA', 403),
    bajaCliente('admin no puede borrar globalmente', 'adminA', 403),
    bajaCliente('tenant ajeno', 'adminB', 404),
    bajaPorDistribuidora('id mal formado', 'adminA', 400, {
      ruta: '/v2/customers/xx/distributor',
      code: 'INVALID_ID',
    }),
    bajaPorDistribuidora('sin token', undefined, 401),
    bajaPorDistribuidora('cliente', 'clienteA', 403),
    bajaPorDistribuidora('tenant ajeno', 'adminB', 404),
    bajaPorDistribuidora('cliente con pedido en curso', 'adminA', 409, {
      // El pedido se crea como lo haría el cliente y se cancela al terminar,
      // para que el caso siguiente (la baja que sí procede) no lo encuentre.
      antes: async (c) => {
        const r = await llamar(c, 'post', '/orders', 'clienteA', {
          customerId: c.clienteA.userId,
          addressId: c.addressA,
          paymentMethod: 'cash',
          items: [{ gasCylinderId: c.gasCylinderA, quantity: 1, unitPrice: 1 }],
        });
        expect(r.status).toBe(201);
        pedidoEnCurso = (r.body as { order_id: string }).order_id;
      },
      verificar: async (_b, c) => {
        const r = await llamar(c, 'get', `/customers/${c.customerA}`, 'adminA');
        expect(r.status).toBe(200);
        const cancelado = await llamar(
          c,
          'patch',
          `/orders/${pedidoEnCurso}/cancel`,
          'clienteA',
          { reason: 'Fin del caso de prueba' },
        );
        expect(cancelado.status).toBe(200);
      },
    }),
    restaurarPorDistribuidora('id mal formado', 'adminA', 400, {
      ruta: '/v2/customers/xx/distributor',
      code: 'INVALID_ID',
    }),
    restaurarPorDistribuidora('sin token', undefined, 401),
    restaurarPorDistribuidora('cliente', 'clienteA', 403),
    restaurarPorDistribuidora('no dado de baja', 'adminA', 404),
    bajaPorDistribuidora(
      'da de baja al cliente sólo en su distribuidora',
      'adminA',
      200,
      {
        verificar: async (_b, c) => {
          const r = await llamar(
            c,
            'get',
            `/customers/${c.customerA}`,
            'adminA',
          );
          expect(r.status).toBe(404);
        },
      },
    ),
    restaurarPorDistribuidora(
      'reactiva al cliente en su distribuidora',
      'adminA',
      200,
      {
        verificar: async (_b, c) => {
          const r = await llamar(
            c,
            'get',
            `/customers/${c.customerA}`,
            'adminA',
          );
          expect(r.status).toBe(200);
        },
      },
    ),
    bajaCliente(
      'super administrador da de baja lógicamente al cliente',
      'superEnA',
      200,
      {
        verificar: async (_b, c) => {
          const r = await llamar(
            c,
            'get',
            `/customers/${c.customerA}`,
            'superEnA',
          );
          expect(r.status).toBe(404);
        },
      },
    ),
  ];
  correrMatriz('mutaciones de direcciones', ver, mutaciones);
});
