/**
 * M1, CU-171 y CU-173 contra la API con Postgres y Redis reales:
 *  - `GET/PUT /module-config/dispatch` y `/module-config/scheduled_tasks`:
 *    valores por omisión, cada validación, quién modificó, rol y distribuidora.
 *  - El despacho lee la configuración en cada oferta (ventana, pasos de radio,
 *    asignación manual) y las ofertas ya enviadas conservan su vencimiento.
 *  - El tic del despacho atiende a cada distribuidora según su intervalo, con la
 *    marca de última ejecución en Redis, y guardar la configuración la borra.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
  patenteDePrueba,
  cuitDePrueba,
} from './setup/test-env';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Car } from '../../src/car/entities/car.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { DispatchSettingsService } from '../../src/distributor/dispatch-settings.service';
import { ModuleConfigService } from '../../src/distributor/module-config.service';
import { ScheduledTasksSettingsService } from '../../src/distributor/scheduled-tasks-settings.service';
import { DispatchOrchestratorService } from '../../src/order/application/dispatch-orchestrator.service';
import { DispatchService } from '../../src/order/dispatch.service';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../../src/order/entities/dispatch-offer.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { OrderService } from '../../src/order/order.service';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';
import { RedisService } from '../../src/redis/redis.service';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { etiquetaDeCampo } from '../../src/common/validation/etiquetas';
import { conSesionDeSoporte } from './matriz-http/soporte';

type Headers = Record<string, string>;

const LAT = -34.6037;
const LNG = -58.3816;
/** ~1,1 km por cada 0,01 grado de latitud. */
const KM = 0.009;

const DESPACHO_VALIDO = { radiusStepsKm: [3, 6, 9], offerTtlSeconds: 90 };
const TAREAS_VALIDAS = {
  dispatchRetrySeconds: 60,
  reservationActivationSeconds: 600,
  unpaidReservationExpirySeconds: 7200,
  unpaidMercadoPagoExpirySeconds: 3600,
  fleetAlertHour: 20,
};

describe('Parámetros del despacho y frecuencia de tareas (CU-171, CU-173, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let realtime: RealtimeDispatchPort;
  let orchestrator: DispatchOrchestratorService;
  let redis: RedisService;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    realtime = env.app.get(RealtimeDispatchPort);
    orchestrator = env.app.get(DispatchOrchestratorService);
    redis = env.app.get(RedisService);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());

  async function usuario(
    tipo: 'customer' | 'admin' | 'super_admin' | 'delivery',
  ) {
    seq += 1;
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: tipo } })) ??
      (await roles.save({ type: tipo } as Partial<Role>));
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: `${tipo} ${seq}`,
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>);
    return { user, email };
  }

  const h = (email: string, fuente: string, extra: Headers = {}): Headers => ({
    Authorization: `Bearer ${email}`,
    'X-Client-Source': fuente,
    ...extra,
  });

  async function distribuidora(): Promise<Distributor> {
    seq += 1;
    return ds.getRepository(Distributor).save({
      name: `Dist ${seq}`,
      slug: `dist-${seq}-${randomUUID().slice(0, 4)}`,
      legalName: 'Test SRL',
      taxId: cuitDePrueba(),
      email: `d${seq}${Date.now()}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>);
  }

  async function adminDe(d: Distributor) {
    const a = await usuario('admin');
    await ds.getRepository(Admin).save({
      userId: a.user.userId,
      distributorId: d.distributorId,
    } as Partial<Admin>);
    return { userId: a.user.userId, headers: h(a.email, 'panel-app') };
  }

  async function escenario() {
    const dA = await distribuidora();
    const dB = await distribuidora();
    const adminA = await adminDe(dA);
    const adminB = await adminDe(dB);
    const sup = await usuario('super_admin');
    const chofer = await usuario('delivery');
    await ds.getRepository(Delivery).save({
      userId: chofer.user.userId,
      distributorId: dA.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const cliente = await usuario('customer');
    await ds.getRepository(Customer).save({
      userId: cliente.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    return {
      dA,
      dB,
      adminA,
      adminB,
      sup: h(sup.email, 'panel-app'),
      choferH: h(chofer.email, 'driver-app'),
      clienteH: h(cliente.email, 'customer-app'),
    };
  }
  type Esc = Awaited<ReturnType<typeof escenario>>;

  async function nuevoChofer(d: Distributor, lat: number) {
    seq += 1;
    const sufijo = randomUUID().slice(0, 8);
    const user = await ds.getRepository(User).save({
      email: `chofer-${sufijo}@splg.local`,
      fullName: `Chofer ${sufijo}`,
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>);
    const delivery = await ds.getRepository(Delivery).save({
      userId: user.userId,
      distributorId: d.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const auto = await ds.getRepository(Car).save({
      distributorId: d.distributorId,
      userId: user.userId,
      carPatent: patenteDePrueba(),
    } as Partial<Car>);
    await ds.getRepository(VehicleAssignment).save({
      distributorId: d.distributorId,
      carId: auto.carId,
      deliveryId: delivery.deliveryId,
      assignedAt: new Date(),
    } as Partial<VehicleAssignment>);
    await realtime.reportDriverLocation(user.userId, lat, LNG);
    return { userId: user.userId, deliveryId: delivery.deliveryId };
  }

  async function nuevoPedido(d: Distributor): Promise<Order> {
    const sufijo = randomUUID().slice(0, 8);
    const cliente = await ds.getRepository(User).save({
      email: `cli-${sufijo}@splg.local`,
      fullName: 'Cliente',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>);
    await ds.getRepository(Customer).save({
      userId: cliente.userId,
      notificationToken: 'fake-fcm',
    } as Partial<Customer>);
    const address = await ds.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: String(LAT),
      longitude: String(LNG),
    } as Partial<UserAddress>);
    return (await ds.getRepository(Order).save({
      customerId: cliente.userId,
      distributorId: d.distributorId,
      addressId: address.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      totalAmount: 1000,
      subtotalItems: 1000,
      deliveryPoint: { type: 'Point', coordinates: [LNG, LAT] },
    } as unknown as Partial<Order>)) as Order;
  }

  const ofertas = (orderId: string) =>
    ds
      .getRepository(DispatchOffer)
      .find({ where: { orderId }, order: { offeredAt: 'ASC' } });

  const putDespacho = (e: Esc, cuerpo: unknown) =>
    http()
      .put('/module-config/dispatch')
      .set(e.adminA.headers)
      .send(cuerpo as object);
  const putTareas = (e: Esc, cuerpo: unknown) =>
    http()
      .put('/module-config/scheduled_tasks')
      .set(e.adminA.headers)
      .send(cuerpo as object);

  describe('GET y PUT /module-config/dispatch (CU-171)', () => {
    it('sin configurar devuelve los valores por omisión; PUT válido guarda quién lo hizo y GET lo refleja', async () => {
      const e = await escenario();

      const inicial = await http()
        .get('/module-config/dispatch')
        .set(e.adminA.headers)
        .expect(200);
      expect(inicial.body).toEqual({
        radiusStepsKm: [5, 10, 15, 20],
        offerTtlSeconds: 30,
        finishingRadiusMeters: 300,
        noDriverExpiryMinutes: 120,
        arrivalRadiusMeters: 150,
        isDefault: true,
        updatedAt: null,
        updatedByUserId: null,
      });

      const guardado = await putDespacho(e, DESPACHO_VALIDO).expect(200);
      expect(guardado.body).toMatchObject({
        ...DESPACHO_VALIDO,
        isDefault: false,
        updatedByUserId: e.adminA.userId,
      });

      const releido = await http()
        .get('/module-config/dispatch')
        .set(e.adminA.headers)
        .expect(200);
      expect(releido.body).toEqual(guardado.body);

      const [fila] = await ds.query<Array<{ updated_by_user_id: string }>>(
        `SELECT updated_by_user_id FROM module_config WHERE distributor_id = $1 AND module = 'dispatch'`,
        [e.dA.distributorId],
      );
      expect(fila.updated_by_user_id).toBe(e.adminA.userId);
    });

    it('PUT parcial: lo que falta se lee por omisión; PUT sin campos restablece y devuelve isDefault true', async () => {
      const e = await escenario();

      const parcial = await putDespacho(e, { offerTtlSeconds: 90 }).expect(200);
      expect(parcial.body).toMatchObject({
        radiusStepsKm: [5, 10, 15, 20],
        offerTtlSeconds: 90,
        isDefault: false,
      });

      const restablecida = await putDespacho(e, {}).expect(200);
      expect(restablecida.body).toMatchObject({
        radiusStepsKm: [5, 10, 15, 20],
        offerTtlSeconds: 30,
        isDefault: true,
      });
      // Y lo que viene sigue validándose aunque el otro campo falte.
      await putDespacho(e, { radiusStepsKm: [10, 5] }).expect(400);
    });

    it('guardar los mismos valores que los de omisión también es isDefault true', async () => {
      const e = await escenario();
      const res = await putDespacho(e, {
        radiusStepsKm: [5, 10, 15, 20],
        offerTtlSeconds: 30,
      }).expect(200);
      expect((res.body as { isDefault: boolean }).isDefault).toBe(true);
    });

    it('cada distribuidora tiene la suya: la de A no toca a B', async () => {
      const e = await escenario();
      await putDespacho(e, DESPACHO_VALIDO).expect(200);

      const deB = await http()
        .get('/module-config/dispatch')
        .set(e.adminB.headers)
        .expect(200);
      expect(deB.body).toMatchObject({
        radiusStepsKm: [5, 10, 15, 20],
        offerTtlSeconds: 30,
        isDefault: true,
      });
    });

    it('un admin no elige distribuidora con X-Distributor: rige la suya', async () => {
      const e = await escenario();
      await http()
        .put('/module-config/dispatch')
        .set({ ...e.adminA.headers, 'X-Distributor': e.dB.distributorId })
        .send(DESPACHO_VALIDO)
        .expect(200);

      const deB = await http()
        .get('/module-config/dispatch')
        .set(e.adminB.headers)
        .expect(200);
      expect((deB.body as { isDefault: boolean }).isDefault).toBe(true);
    });

    it.each([
      ['lista vacía', { radiusStepsKm: [], offerTtlSeconds: 30 }],
      [
        'más de ocho pasos',
        { radiusStepsKm: [1, 2, 3, 4, 5, 6, 7, 8, 9], offerTtlSeconds: 30 },
      ],
      ['pasos repetidos', { radiusStepsKm: [5, 5], offerTtlSeconds: 30 }],
      ['pasos desordenados', { radiusStepsKm: [10, 5], offerTtlSeconds: 30 }],
      ['paso menor a 1 km', { radiusStepsKm: [0], offerTtlSeconds: 30 }],
      ['paso mayor a 100 km', { radiusStepsKm: [101], offerTtlSeconds: 30 }],
      ['ventana de 9 s', { radiusStepsKm: [5], offerTtlSeconds: 9 }],
      ['ventana de 301 s', { radiusStepsKm: [5], offerTtlSeconds: 301 }],
      ['radio por terminar negativo', { finishingRadiusMeters: -1 }],
      ['radio por terminar de 5001 m', { finishingRadiusMeters: 5001 }],
      ['radio por terminar fraccionario', { finishingRadiusMeters: 10.5 }],
      ['minutos sin chofer en 0', { noDriverExpiryMinutes: 0 }],
      ['minutos sin chofer de más de 1440', { noDriverExpiryMinutes: 1441 }],
      ['minutos sin chofer fraccionarios', { noDriverExpiryMinutes: 30.5 }],
      ['minutos sin chofer como texto', { noDriverExpiryMinutes: '120' }],
      ['radio de llegada negativo', { arrivalRadiusMeters: -1 }],
      ['radio de llegada de 5001 m', { arrivalRadiusMeters: 5001 }],
      ['radio de llegada fraccionario', { arrivalRadiusMeters: 10.5 }],
      [
        'campo desconocido',
        { radiusStepsKm: [5], offerTtlSeconds: 30, otro: 1 },
      ],
    ])('400 con el detalle del campo: %s', async (_caso, cuerpo) => {
      const e = await escenario();
      const res = await putDespacho(e, cuerpo).expect(400);
      expect(JSON.stringify(res.body)).toMatch(
        /Escalones de radio|Segundos de vigencia de la oferta|Radio de cierre|Minutos sin chofer antes de cancelar el pedido|Radio para marcar Llegué \(metros\)|dato que no corresponde/,
      );
      // Lo rechazado no se guardó.
      const filas = await ds.query<unknown[]>(
        `SELECT 1 FROM module_config WHERE module = 'dispatch'`,
      );
      expect(filas).toHaveLength(0);
    });

    it('aplica los límites exactos: 1 paso de 1 km con ventana de 10 s, y 8 pasos hasta 100 km con 300 s', async () => {
      const e = await escenario();
      await putDespacho(e, {
        radiusStepsKm: [1],
        offerTtlSeconds: 10,
      }).expect(200);
      await putDespacho(e, {
        radiusStepsKm: [1, 2, 3, 4, 5, 6, 7, 100],
        offerTtlSeconds: 300,
      }).expect(200);
    });

    it('radio por terminar (CU-013): 0 lo apaga, 5000 es el tope y se lee por omisión si no viene', async () => {
      const e = await escenario();
      const apagado = await putDespacho(e, { finishingRadiusMeters: 0 }).expect(
        200,
      );
      expect(apagado.body).toMatchObject({
        finishingRadiusMeters: 0,
        isDefault: false,
      });
      await putDespacho(e, { finishingRadiusMeters: 5000 }).expect(200);
      const parcial = await putDespacho(e, { offerTtlSeconds: 60 }).expect(200);
      expect(parcial.body).toMatchObject({ finishingRadiusMeters: 300 });
    });

    it('minutos sin chofer: 1 y 1440 son los topes, guardar otro valor deja de ser isDefault y si no viene se lee 120', async () => {
      const e = await escenario();
      const corto = await putDespacho(e, { noDriverExpiryMinutes: 1 }).expect(
        200,
      );
      expect(corto.body).toMatchObject({
        noDriverExpiryMinutes: 1,
        isDefault: false,
      });
      await putDespacho(e, { noDriverExpiryMinutes: 1440 }).expect(200);
      const releido = await http()
        .get('/module-config/dispatch')
        .set(e.adminA.headers)
        .expect(200);
      expect(releido.body).toMatchObject({ noDriverExpiryMinutes: 1440 });
      const parcial = await putDespacho(e, { offerTtlSeconds: 60 }).expect(200);
      expect(parcial.body).toMatchObject({ noDriverExpiryMinutes: 120 });
      const deB = await http()
        .get('/module-config/dispatch')
        .set(e.adminB.headers)
        .expect(200);
      expect(deB.body).toMatchObject({ noDriverExpiryMinutes: 120 });
    });

    it('radio de llegada: 0 lo apaga, 5000 es el tope y si no viene se lee 150', async () => {
      const e = await escenario();
      const apagado = await putDespacho(e, { arrivalRadiusMeters: 0 }).expect(
        200,
      );
      expect(apagado.body).toMatchObject({
        arrivalRadiusMeters: 0,
        isDefault: false,
      });
      await putDespacho(e, { arrivalRadiusMeters: 5000 }).expect(200);
      const parcial = await putDespacho(e, { offerTtlSeconds: 60 }).expect(200);
      expect(parcial.body).toMatchObject({ arrivalRadiusMeters: 150 });
    });

    it('super admin: sin sesión de soporte 403 (también con X-Distributor); en modo soporte lee y no escribe', async () => {
      const e = await escenario();
      const soporte = (await conSesionDeSoporte(env.app, e.dB.distributorId))
        .cabeceras;

      for (const cabeceras of [
        e.sup,
        { ...e.sup, 'X-Distributor': e.dB.distributorId },
      ]) {
        for (const llamada of [
          () => http().get('/module-config/dispatch').set(cabeceras),
          () =>
            http()
              .put('/module-config/dispatch')
              .set(cabeceras)
              .send(DESPACHO_VALIDO),
          () => http().get('/module-config/scheduled_tasks').set(cabeceras),
          () =>
            http()
              .put('/module-config/scheduled_tasks')
              .set(cabeceras)
              .send(TAREAS_VALIDAS),
        ]) {
          const res = await llamada();
          expect(res.body).toMatchObject({
            statusCode: 403,
            code: 'SUPPORT_SESSION_REQUIRED',
          });
        }
      }

      const antes = await http()
        .get('/module-config/dispatch')
        .set(soporte)
        .expect(200);
      await http()
        .put('/module-config/dispatch')
        .set(soporte)
        .send({ ...DESPACHO_VALIDO, offerTtlSeconds: 77 })
        .expect(403);
      const despues = await http()
        .get('/module-config/dispatch')
        .set(e.adminB.headers)
        .expect(200);
      expect(despues.body).toEqual(antes.body);
    });

    it('chofer y cliente: 403; sin token: 401', async () => {
      const e = await escenario();
      for (const headers of [e.choferH, e.clienteH]) {
        await http().get('/module-config/dispatch').set(headers).expect(403);
        await http()
          .put('/module-config/dispatch')
          .set(headers)
          .send(DESPACHO_VALIDO)
          .expect(403);
        await http()
          .get('/module-config/scheduled_tasks')
          .set(headers)
          .expect(403);
        await http()
          .put('/module-config/scheduled_tasks')
          .set(headers)
          .send(TAREAS_VALIDAS)
          .expect(403);
      }
      await http().get('/module-config/dispatch').expect(401);
    });
  });

  describe('El despacho lee la configuración en cada oferta', () => {
    it('la oferta nueva usa la ventana nueva; la ya enviada conserva su vencimiento', async () => {
      const e = await escenario();
      const chofer1 = await nuevoChofer(e.dA, LAT + KM * 0.1);
      await nuevoChofer(e.dA, LAT + KM * 0.2);
      const pedido1 = await nuevoPedido(e.dA);
      const pedido2 = await nuevoPedido(e.dA);

      // Con los valores por omisión: 30 s.
      expect(await orchestrator.offerToNextDriver(pedido1)).toBe(
        chofer1.userId,
      );
      const [antes] = await ofertas(pedido1.orderId);
      expect(
        antes.expiresAt.getTime() - antes.offeredAt.getTime(),
      ).toBeLessThan(35_000);

      await putDespacho(e, DESPACHO_VALIDO).expect(200);

      // La anterior no cambió.
      const [mismaOferta] = await ofertas(pedido1.orderId);
      expect(mismaOferta.expiresAt.getTime()).toBe(antes.expiresAt.getTime());

      // La próxima, con 90 s, aunque la copia en memoria ya estaba cargada.
      await orchestrator.offerToNextDriver(pedido2);
      const [nueva] = await ofertas(pedido2.orderId);
      const ttl = nueva.expiresAt.getTime() - nueva.offeredAt.getTime();
      expect(ttl).toBeGreaterThanOrEqual(89_000);
      expect(ttl).toBeLessThan(95_000);
    });

    it('guardar descarta la copia en memoria: el cambio rige en la misma instancia sin esperar el minuto', async () => {
      const e = await escenario();
      const settings = env.app.get(DispatchSettingsService);
      expect((await settings.obtener(e.dA.distributorId)).offerTtlSeconds).toBe(
        30,
      );

      await putDespacho(e, DESPACHO_VALIDO).expect(200);

      expect((await settings.obtener(e.dA.distributorId)).offerTtlSeconds).toBe(
        90,
      );
    });

    it('los pasos de radio configurados mandan: con [1] un chofer a 3 km no recibe la oferta; con [1, 5] sí', async () => {
      const e = await escenario();
      const lejos = await nuevoChofer(e.dA, LAT + KM * 3);
      const pedido = await nuevoPedido(e.dA);

      await putDespacho(e, { radiusStepsKm: [1], offerTtlSeconds: 30 }).expect(
        200,
      );
      expect(await orchestrator.offerToNextDriver(pedido)).toBeNull();
      expect(await ofertas(pedido.orderId)).toHaveLength(0);

      await putDespacho(e, {
        radiusStepsKm: [1, 5],
        offerTtlSeconds: 30,
      }).expect(200);
      expect(await orchestrator.offerToNextDriver(pedido)).toBe(lejos.userId);
    });

    it('la configuración de A no cambia la ventana de los pedidos de B', async () => {
      const e = await escenario();
      await nuevoChofer(e.dB, LAT + KM * 0.1);
      const pedidoB = await nuevoPedido(e.dB);
      await putDespacho(e, DESPACHO_VALIDO).expect(200);

      await orchestrator.offerToNextDriver(pedidoB);
      const [oferta] = await ofertas(pedidoB.orderId);
      expect(
        oferta.expiresAt.getTime() - oferta.offeredAt.getTime(),
      ).toBeLessThan(35_000);
    });

    it('la asignación manual avisa al chofer con la ventana de la distribuidora', async () => {
      const e = await escenario();
      const chofer = await nuevoChofer(e.dA, LAT + KM * 0.1);
      const pedido = await nuevoPedido(e.dA);
      await putDespacho(e, DESPACHO_VALIDO).expect(200);
      const avisar = jest.spyOn(realtime, 'notifyDriverNewOrder');
      avisar.mockClear();

      const antes = Date.now();
      await env.app
        .get(OrderService)
        .assignDelivery(pedido.orderId, chofer.deliveryId, e.dA.distributorId);

      const payload = avisar.mock.calls[0][1] as { expiresAt: string };
      const ttl = new Date(payload.expiresAt).getTime() - antes;
      expect(ttl).toBeGreaterThanOrEqual(89_000);
      expect(ttl).toBeLessThan(95_000);
    });
  });

  describe('GET y PUT /module-config/scheduled_tasks (CU-173)', () => {
    it('sin configurar devuelve los valores vigentes; PUT válido guarda y GET lo refleja', async () => {
      const e = await escenario();

      const inicial = await http()
        .get('/module-config/scheduled_tasks')
        .set(e.adminA.headers)
        .expect(200);
      expect(inicial.body).toEqual({
        dispatchRetrySeconds: 15,
        reservationActivationSeconds: 300,
        unpaidReservationExpirySeconds: 3600,
        unpaidMercadoPagoExpirySeconds: 1800,
        fleetAlertHour: 8,
        isDefault: true,
        updatedAt: null,
        updatedByUserId: null,
      });

      const guardado = await putTareas(e, TAREAS_VALIDAS).expect(200);
      expect(guardado.body).toMatchObject({
        ...TAREAS_VALIDAS,
        isDefault: false,
        updatedByUserId: e.adminA.userId,
      });
      const releido = await http()
        .get('/module-config/scheduled_tasks')
        .set(e.adminA.headers)
        .expect(200);
      expect(releido.body).toEqual(guardado.body);
    });

    it.each([
      ['reintentos que no es múltiplo de 15', { dispatchRetrySeconds: 20 }],
      [
        'activación que no es múltiplo de 300',
        { reservationActivationSeconds: 400 },
      ],
      [
        'reservas sin seña que no es múltiplo de 3600',
        { unpaidReservationExpirySeconds: 5400 },
      ],
      [
        'MercadoPago que no es múltiplo de 1800',
        { unpaidMercadoPagoExpirySeconds: 2000 },
      ],
      ['reintentos de más de 5 min', { dispatchRetrySeconds: 315 }],
      [
        'reservas sin seña de más de 24 h',
        { unpaidReservationExpirySeconds: 90000 },
      ],
      ['intervalo cero', { dispatchRetrySeconds: 0 }],
      ['hora 24', { fleetAlertHour: 24 }],
      ['hora negativa', { fleetAlertHour: -1 }],
    ])('400 con el detalle del campo: %s', async (_caso, cambio) => {
      const e = await escenario();
      const res = await putTareas(e, { ...TAREAS_VALIDAS, ...cambio }).expect(
        400,
      );
      const campo = Object.keys(cambio)[0];
      expect(JSON.stringify(res.body)).toContain(etiquetaDeCampo(campo));
      expect(JSON.stringify(res.body)).not.toContain(campo);
    });

    it('PUT parcial: lo que no se manda se lee con su valor por omisión; PUT sin campos restablece (isDefault true)', async () => {
      const e = await escenario();

      const parcial = await putTareas(e, { fleetAlertHour: 20 }).expect(200);
      expect(parcial.body).toMatchObject({
        dispatchRetrySeconds: 15,
        reservationActivationSeconds: 300,
        fleetAlertHour: 20,
        isDefault: false,
      });
      const [fila] = await ds.query<Array<{ params: unknown }>>(
        `SELECT params FROM module_config WHERE distributor_id = $1 AND module = 'scheduled_tasks'`,
        [e.dA.distributorId],
      );
      expect(fila.params).toEqual({ fleetAlertHour: 20 });

      const restablecida = await putTareas(e, {}).expect(200);
      expect(restablecida.body).toMatchObject({
        fleetAlertHour: 8,
        isDefault: true,
      });
      const releida = await http()
        .get('/module-config/scheduled_tasks')
        .set(e.adminA.headers)
        .expect(200);
      expect((releida.body as { isDefault: boolean }).isDefault).toBe(true);
    });

    it('el reintento del despacho topa en 300 s: 315 y 86400 son 400', async () => {
      const e = await escenario();
      await putTareas(e, { dispatchRetrySeconds: 300 }).expect(200);
      await putTareas(e, { dispatchRetrySeconds: 315 }).expect(400);
      await putTareas(e, { dispatchRetrySeconds: 86400 }).expect(400);
    });

    it('acepta exactamente 24 h y las horas 0 y 23', async () => {
      const e = await escenario();
      await putTareas(e, {
        ...TAREAS_VALIDAS,
        unpaidReservationExpirySeconds: 86400,
        fleetAlertHour: 0,
      }).expect(200);
      await putTareas(e, { ...TAREAS_VALIDAS, fleetAlertHour: 23 }).expect(200);
    });
  });

  describe('El tic atiende a cada distribuidora según su intervalo', () => {
    /** La marca vigente: su clave lleva la generación de la configuración. */
    const marca = async (tarea: string, d: Distributor) => {
      const gen =
        (await redis.get(`scheduled-task:gen:${d.distributorId}`)) ?? '0';
      return redis.get(`scheduled-task:${tarea}:${d.distributorId}:${gen}`);
    };

    it('con intervalo mayor al tic, deja pasar una vez y la marca bloquea los ciclos siguientes; guardar la invalida', async () => {
      const e = await escenario();
      const tareas = env.app.get(ScheduledTasksSettingsService);
      await putTareas(e, TAREAS_VALIDAS).expect(200);
      const dA = e.dA.distributorId;
      const dB = e.dB.distributorId;

      expect([
        ...(await tareas.distribuidorasQueCorren('dispatchRetrySeconds', [dA])),
      ]).toEqual([dA]);
      expect(await marca('dispatchRetrySeconds', e.dA)).not.toBeNull();

      const ciclo2 = await tareas.distribuidorasQueCorren(
        'dispatchRetrySeconds',
        [dA, dB],
      );
      // A todavía no cumplió; B no configuró nada: corre en todos los ciclos y no deja marca.
      expect([...ciclo2]).toEqual([dB]);
      expect(await marca('dispatchRetrySeconds', e.dB)).toBeNull();

      // Cambiar la configuración sube la generación: la marca vieja ya no cuenta.
      await putTareas(e, TAREAS_VALIDAS).expect(200);
      expect(await marca('dispatchRetrySeconds', e.dA)).toBeNull();
      expect([
        ...(await tareas.distribuidorasQueCorren('dispatchRetrySeconds', [dA])),
      ]).toEqual([dA]);
    });

    it('un PUT cambia el intervalo en la misma instancia sin esperar la caché: el tic siguiente respeta el nuevo', async () => {
      const e = await escenario();
      const tareas = env.app.get(ScheduledTasksSettingsService);
      const dA = e.dA.distributorId;
      await putTareas(e, TAREAS_VALIDAS).expect(200); // 60 s
      await tareas.distribuidorasQueCorren('dispatchRetrySeconds', [dA]);

      await putTareas(e, { dispatchRetrySeconds: 300 }).expect(200);

      expect([
        ...(await tareas.distribuidorasQueCorren('dispatchRetrySeconds', [dA])),
      ]).toEqual([dA]);
      expect(
        (await tareas.distribuidorasQueCorren('dispatchRetrySeconds', [dA]))
          .size,
      ).toBe(0);
      expect((await tareas.obtener(dA)).dispatchRetrySeconds).toBe(300);
    });

    it('otra instancia con la caché vieja: tras el PUT respeta el intervalo nuevo sin esperar el minuto', async () => {
      const e = await escenario();
      const dA = e.dA.distributorId;
      const otraInstancia = new ScheduledTasksSettingsService(
        env.app.get(ModuleConfigService),
        redis,
      );
      expect((await otraInstancia.obtener(dA)).dispatchRetrySeconds).toBe(15);

      await putTareas(e, { dispatchRetrySeconds: 120 }).expect(200);

      expect((await otraInstancia.obtener(dA)).dispatchRetrySeconds).toBe(120);
      expect([
        ...(await otraInstancia.distribuidorasQueCorren(
          'dispatchRetrySeconds',
          [dA],
        )),
      ]).toEqual([dA]);
      expect(
        (
          await otraInstancia.distribuidorasQueCorren('dispatchRetrySeconds', [
            dA,
          ])
        ).size,
      ).toBe(0);
    });

    it('el tic del despacho vence y re-ofrece sólo a la distribuidora a la que le toca', async () => {
      const e = await escenario();
      const tic = env.app.get(DispatchService);
      await putTareas(e, TAREAS_VALIDAS).expect(200); // A cada 60 s; B cada 15 s

      const armar = async (d: Distributor) => {
        await nuevoChofer(d, LAT + KM * 0.1);
        await nuevoChofer(d, LAT + KM * 0.2);
        const pedido = await nuevoPedido(d);
        await orchestrator.offerToNextDriver(pedido);
        return pedido;
      };
      const vencer = (orderId: string) =>
        ds.query(
          `UPDATE order_dispatch_offer SET "expiresAt" = now() - interval '1 minute',
           "offeredAt" = now() - interval '1 minute' - ("expiresAt" - "offeredAt")
           WHERE order_id = $1 AND status = 'offered'`,
          [orderId],
        );
      const estados = async (orderId: string) =>
        (await ofertas(orderId)).map((o) => o.status);

      const pedidoA = await armar(e.dA);
      const pedidoB = await armar(e.dB);

      // Ciclo 1: a las dos les toca (A no tenía marca).
      await vencer(pedidoA.orderId);
      await vencer(pedidoB.orderId);
      await tic.tick();
      expect(await estados(pedidoA.orderId)).toEqual([
        DispatchOfferStatus.EXPIRED,
        DispatchOfferStatus.OFFERED,
      ]);
      expect(await estados(pedidoB.orderId)).toEqual([
        DispatchOfferStatus.EXPIRED,
        DispatchOfferStatus.OFFERED,
      ]);

      // Ciclo 2: A todavía no cumplió sus 60 s; B sí corre.
      await vencer(pedidoA.orderId);
      await vencer(pedidoB.orderId);
      await tic.tick();
      expect(await estados(pedidoA.orderId)).toEqual([
        DispatchOfferStatus.EXPIRED,
        DispatchOfferStatus.OFFERED,
      ]);
      expect(await estados(pedidoB.orderId)).toEqual([
        DispatchOfferStatus.EXPIRED,
        DispatchOfferStatus.EXPIRED,
      ]);

      // Guardar la configuración borra las marcas: A corre en el ciclo siguiente.
      await putTareas(e, TAREAS_VALIDAS).expect(200);
      await tic.tick();
      expect(await estados(pedidoA.orderId)).toEqual([
        DispatchOfferStatus.EXPIRED,
        DispatchOfferStatus.EXPIRED,
      ]);
    }, 60000);
  });
});
