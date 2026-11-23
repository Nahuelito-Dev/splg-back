/**
 * Blindaje de la revisión integral (12/10): accesos del chofer, distribuidora
 * obligatoria del super admin, EXIF, idempotencia, cobros manuales, historial de
 * estados, cotización y datos del chofer. Todo contra Postgres, Redis y MinIO
 * reales (contenedores efímeros).
 */
import { randomUUID } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { conSesionDeSoporte } from './matriz-http/soporte';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
  patenteDePrueba,
  cuitDePrueba,
} from './setup/test-env';
import { BUCKET_DE_PRUEBA, TestMinio, startMinio } from './setup/minio';
import sharp from 'sharp';
import { imagenesDePrueba } from '../../src/s3/imagenes-de-prueba';
import { JPG_CON_GPS, PNG_REAL, tieneExif } from './setup/imagenes';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../src/car/entities/vehicle-assignment.entity';
import { Claim } from '../../src/claims/entities/claim.entity';
import { StockLocationService } from '../../src/stock/application/stock-location.service';
import { RedisService } from '../../src/redis/redis.service';
import { TruckLoadItem } from '../../src/truck-load/entities/truck-load-item.entity';
import { TruckLoad } from '../../src/truck-load/entities/truck-load.entity';
import { TruckLoadStatus } from '../../src/truck-load/domain/truck-load.enums';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import {
  Incident,
  IncidentStatus,
  IncidentType,
} from '../../src/incident/entities/incident.entity';
import { OrderStatusHistory } from '../../src/order/entities/order-status-history.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '../../src/order/entities/order.entity';
import { Rating, RaterRole } from '../../src/rating/entities/rating.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { fechasSegunEstado } from './setup/pedido-valido';
import { forzarEstado } from './setup/bypass';
import { diaArgentino } from '../../src/common/utils/dias-argentina';

type Headers = Record<string, string>;

describe('Blindaje (e2e)', () => {
  let minio: TestMinio;
  let env: TestEnv;
  let ds: DataSource;
  let seq = 0;

  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({ s3: minio.env });
    ds = env.app.get(DataSource);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
    await minio.stop();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function usuario(
    tipo: 'customer' | 'admin' | 'super_admin' | 'delivery',
    nombre: string,
  ) {
    seq += 1;
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: nombre,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
    } as Partial<User>);
    return { user, email };
  }

  async function distribuidora(nombre: string): Promise<Distributor> {
    seq += 1;
    return ds.getRepository(Distributor).save({
      name: nombre,
      slug: `dist-${seq}-${randomUUID().slice(0, 4)}`,
      legalName: 'Test SRL',
      taxId: cuitDePrueba(),
      email: `d${seq}${Date.now()}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>);
  }

  async function escenario() {
    const dA = await distribuidora('Distribuidora A');
    const dB = await distribuidora('Distribuidora B');

    const adminA = await usuario('admin', 'Admin A');
    await ds.getRepository(Admin).save({
      userId: adminA.user.userId,
      distributorId: dA.distributorId,
    } as Partial<Admin>);
    const adminB = await usuario('admin', 'Admin B');
    await ds.getRepository(Admin).save({
      userId: adminB.user.userId,
      distributorId: dB.distributorId,
    } as Partial<Admin>);
    const sup = await usuario('super_admin', 'Super');

    const chofer1 = await usuario('delivery', 'Ana Chofer');
    const del1 = await ds.getRepository(Delivery).save({
      userId: chofer1.user.userId,
      distributorId: dA.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    // Con vehículo en uso: el gate de flota deja asignarle pedidos.
    const auto = await ds.getRepository(Car).save({
      distributorId: dA.distributorId,
      userId: chofer1.user.userId,
      carPatent: patenteDePrueba(),
    } as Partial<Car>);
    await ds.getRepository(VehicleAssignment).save({
      distributorId: dA.distributorId,
      carId: auto.carId,
      deliveryId: del1.deliveryId,
      assignedAt: new Date(),
    } as Partial<VehicleAssignment>);
    const chofer2 = await usuario('delivery', 'Beto Chofer');
    const del2 = await ds.getRepository(Delivery).save({
      userId: chofer2.user.userId,
      distributorId: dA.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);

    const cli = await usuario('customer', 'Cliente Uno');
    await ds.getRepository(Customer).save({
      userId: cli.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const cli2 = await usuario('customer', 'Cliente Dos');
    await ds.getRepository(Customer).save({
      userId: cli2.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const dir = await ds.getRepository(UserAddress).save({
      userId: cli.user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
    const garrafa = await ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 50,
      weight: 10,
      isActive: true,
      distributorId: dA.distributorId,
    } as Partial<GasCylinder>);

    const h = (
      email: string,
      fuente: string,
      extra: Headers = {},
    ): Headers => ({
      Authorization: `Bearer ${email}`,
      'X-Client-Source': fuente,
      ...extra,
    });
    return {
      dA,
      dB,
      del1,
      del2,
      cli: cli.user,
      cli2: cli2.user,
      dir,
      garrafa,
      adminA: h(adminA.email, 'panel-app'),
      adminB: h(adminB.email, 'panel-app'),
      adminAUserId: adminA.user.userId,
      supSinHeader: h(sup.email, 'panel-app'),
      supEnA: h(sup.email, 'panel-app', { 'X-Distributor': dA.slug }),
      supEnB: h(sup.email, 'panel-app', { 'X-Distributor': dB.slug }),
      chofer1: h(chofer1.email, 'delivery-app'),
      chofer1UserId: chofer1.user.userId,
      carId: auto.carId,
      adminUserId: adminA.user.userId,
      chofer2: h(chofer2.email, 'delivery-app'),
      cliente: h(cli.email, 'customer-app', { 'X-Distributor': dA.slug }),
      cliente2: h(cli2.email, 'customer-app', { 'X-Distributor': dA.slug }),
    };
  }
  type E = Awaited<ReturnType<typeof escenario>>;

  async function pedido(e: E, parcial: Partial<Order> = {}): Promise<Order> {
    return ds.getRepository(Order).save({
      customerId: e.cli.userId,
      distributorId: e.dA.distributorId,
      addressId: e.dir.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.PENDING,
      totalAmount: 1000,
      subtotalItems: 1000,
      ...fechasSegunEstado(parcial.status ?? OrderStatus.PENDING),
      ...(parcial.status !== undefined &&
        [
          OrderStatus.ACCEPTED,
          OrderStatus.ON_THE_WAY,
          OrderStatus.DELIVERED,
        ].includes(parcial.status) && { deliveryId: e.del1.deliveryId }),
      ...parcial,
    } as Partial<Order>) as Promise<Order>;
  }

  describe('el chofer sólo ve lo suyo', () => {
    it('lee el pedido asignado y uno del pool; el de otro chofer es 404', async () => {
      const e = await escenario();
      const mio = await pedido(e, {
        status: OrderStatus.ACCEPTED,
        deliveryId: e.del1.deliveryId,
      });
      const ajeno = await pedido(e, {
        status: OrderStatus.ACCEPTED,
        deliveryId: e.del2.deliveryId,
      });
      const pool = await pedido(e);

      await http().get(`/orders/${mio.orderId}`).set(e.chofer1).expect(200);
      await http().get(`/orders/${pool.orderId}`).set(e.chofer1).expect(200);
      await http().get(`/orders/${ajeno.orderId}`).set(e.chofer1).expect(404);
      // El admin y el cliente dueño siguen leyendo.
      await http().get(`/orders/${ajeno.orderId}`).set(e.adminA).expect(200);
      await http().get(`/orders/${ajeno.orderId}`).set(e.cliente).expect(200);
    });

    it('un pedido de otra distribuidora es 404 aunque esté pendiente', async () => {
      const e = await escenario();
      const deB = await pedido(e, { distributorId: e.dB.distributorId });
      await http().get(`/orders/${deB.orderId}`).set(e.chofer1).expect(404);
    });

    it('no lista los pedidos de un cliente (403); el cliente y el admin sí', async () => {
      const e = await escenario();
      await pedido(e);
      await http()
        .get(`/orders/customer/${e.cli.userId}`)
        .set(e.chofer1)
        .expect(403);
      await http()
        .get(`/orders/customer/${e.cli.userId}`)
        .set(e.adminA)
        .expect(200);
      await http()
        .get(`/orders/customer/${e.cli.userId}`)
        .set(e.cliente)
        .expect(200);
      await http()
        .get(`/orders/customer/${e.cli.userId}`)
        .set(e.cliente2)
        .expect(403);
    });
  });

  describe('el super admin sin sesión de soporte no muta (modo soporte)', () => {
    it('resolve-unpaid, cancelar, asignar y los cobros manuales dan 403 sin sesión de soporte', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.UNPAID,
        deliveryId: e.del1.deliveryId,
        deliveredAt: new Date(),
      });
      const mensaje = 'Para ver datos de una empresa entrá en modo soporte';
      const sup = e.supSinHeader;
      const id = p.orderId;
      const razon = { reason: 'motivo de prueba suficiente' };
      const llamadas = [
        http()
          .patch(`/orders/${id}/payment/resolve-unpaid`)
          .set(sup)
          .send({ resolution: 'paid', note: 'Cobrado en el local' }),
        http().patch(`/orders/${id}/cancel`).set(sup).send({}),
        http().delete(`/orders/${id}`).set(sup),
        http().patch(`/orders/${id}/assign/${e.del1.deliveryId}`).set(sup),
        http()
          .patch(`/orders/${id}/payment/register-cash`)
          .set(sup)
          .send(razon),
        http()
          .patch(`/orders/${id}/payment/register-unpaid`)
          .set(sup)
          .send(razon),
        http().patch(`/orders/${id}/confirm-deposit`).set(sup),
      ];
      for (const res of await Promise.all(llamadas)) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          message: mensaje,
          code: 'SUPPORT_SESSION_REQUIRED',
        });
      }
      const intacto = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(intacto.paymentStatus).toBe(PaymentStatus.UNPAID);
    });

    it('las demás escrituras por UUID (chofer, cliente, auto) dan 403 sin sesión de soporte; las cuentas del personal desde plataforma, 400; y no tocan nada', async () => {
      const e = await escenario();
      const sup = e.supSinHeader;
      const adminDeA = await ds
        .getRepository(Admin)
        .findOneByOrFail({ userId: e.adminAUserId });
      const clienteDeA = await ds
        .getRepository(Customer)
        .findOneByOrFail({ userId: e.cli.userId });
      const mensaje = 'Para ver datos de una empresa entrá en modo soporte';
      const llamadas = [
        http().delete(`/delivery/${e.del1.deliveryId}`).set(sup),
        http().delete(`/customers/${clienteDeA.customerId}`).set(sup),
        http().delete(`/car/${e.carId}/photo`).set(sup),
      ];
      for (const res of await Promise.all(llamadas)) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          message: mensaje,
          code: 'SUPPORT_SESSION_REQUIRED',
        });
      }
      // Las cuentas (admin, usuario) son de las dos versiones: desde plataforma,
      // sobre el personal de una empresa vigente, no hay camino (400).
      for (const res of await Promise.all([
        http().delete(`/admin/${adminDeA.adminId}`).set(sup),
        http().delete(`/users/${e.chofer1UserId}`).set(sup),
        http()
          .patch(`/users/${e.chofer1UserId}/block`)
          .set(sup)
          .send({ block: true }),
      ])) {
        expect(res.body).toMatchObject({
          statusCode: 400,
          code: 'MISSING_DISTRIBUTOR',
        });
      }
      const chofer = await ds
        .getRepository(User)
        .findOneByOrFail({ userId: e.chofer1UserId });
      expect(chofer.blocked).toBe(false);
      expect(
        await ds.getRepository(Delivery).count({
          where: { deliveryId: e.del1.deliveryId },
        }),
      ).toBe(1);
      // El X-Distributor ya no lo habilita, y en modo soporte es sólo lectura.
      await http()
        .patch(`/users/${e.chofer1UserId}/block`)
        .set(e.supEnA)
        .send({ block: true })
        .expect(400);
      const soporte = await conSesionDeSoporte(env.app, e.dA.distributorId);
      const enSoporte = await http()
        .patch(`/users/${e.chofer1UserId}/block`)
        .set(soporte.cabeceras)
        .send({ block: true });
      expect(enSoporte.body).toMatchObject({
        statusCode: 403,
        code: 'SUPPORT_READ_ONLY',
      });
      expect(
        (
          await ds
            .getRepository(User)
            .findOneByOrFail({ userId: e.chofer1UserId })
        ).blocked,
      ).toBe(false);
    });

    it('en modo soporte: el pedido de otra distribuidora es 404, el propio se ve y no se escribe', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.UNPAID,
        deliveryId: e.del1.deliveryId,
        deliveredAt: new Date(),
      });
      const enB = await conSesionDeSoporte(env.app, e.dB.distributorId);
      const enA = await conSesionDeSoporte(env.app, e.dA.distributorId);
      await http().get(`/orders/${p.orderId}`).set(enB.cabeceras).expect(404);
      await http().get(`/orders/${p.orderId}`).set(enA.cabeceras).expect(200);
      await http()
        .patch(`/orders/${p.orderId}/payment/resolve-unpaid`)
        .set(enA.cabeceras)
        .send({ resolution: 'paid', note: 'cobrado después' })
        .expect(403);
      const intacto = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: p.orderId });
      expect(intacto.paymentStatus).toBe(PaymentStatus.UNPAID);
    });

    it('un cliente sin X-Distributor sigue pudiendo cancelar lo suyo', async () => {
      const e = await escenario();
      const p = await pedido(e);
      const sinHeader = { ...e.cliente };
      delete sinHeader['X-Distributor'];
      await http()
        .patch(`/orders/${p.orderId}/cancel`)
        .set(sinHeader)
        .send({ reason: 'me arrepentí' })
        .expect(200);
    });
  });

  describe('EXIF y GPS', () => {
    it('la foto de perfil con GPS se guarda sin metadata (PUT /users/me/photo)', async () => {
      const e = await escenario();
      await http()
        .put('/users/me/photo')
        .set(e.cliente)
        .attach('file', JPG_CON_GPS, {
          filename: 'selfie.jpg',
          contentType: 'image/jpeg',
        })
        .expect(200);
      const fila = await ds
        .getRepository(User)
        .findOneByOrFail({ userId: e.cli.userId });
      const objeto = await minio.client.send(
        new GetObjectCommand({
          Bucket: BUCKET_DE_PRUEBA,
          Key: fila.photoKey as string,
        }),
      );
      const guardado = Buffer.from(
        (await objeto.Body?.transformToByteArray()) ?? [],
      );
      expect(guardado.length).toBeGreaterThan(0);
      expect(await tieneExif(JPG_CON_GPS)).toBe(true);
      expect(await tieneExif(guardado)).toBe(false);
    });

    it('un adjunto de imagen con GPS se guarda sin metadata', async () => {
      const e = await escenario();
      const claim = await http()
        .post('/claims')
        .set(e.cliente)
        .send({
          orderId: (await pedido(e, { status: OrderStatus.DELIVERED })).orderId,
          customerId: e.cli.userId,
          reason: 'producto dañado',
          description: 'foto con GPS',
        });
      expect([200, 201]).toContain(claim.status);
      const id =
        (claim.body as { claimId?: string; claim_id?: string }).claimId ??
        (claim.body as { claim_id?: string }).claim_id;
      await http()
        .post(`/claims/${id}/photo`)
        .set(e.cliente)
        .attach('file', JPG_CON_GPS, {
          filename: 'p.jpg',
          contentType: 'image/jpeg',
        })
        .expect(201);
      const fila = await ds
        .getRepository(Claim)
        .findOneByOrFail({ claimId: id as string });
      const objeto = await minio.client.send(
        new GetObjectCommand({
          Bucket: BUCKET_DE_PRUEBA,
          Key: fila.photoKey as string,
        }),
      );
      const guardado = Buffer.from(
        (await objeto.Body?.transformToByteArray()) ?? [],
      );
      expect(await tieneExif(guardado)).toBe(false);
    });

    it('una imagen dañada con firma válida es 415 y no sube nada', async () => {
      const e = await escenario();
      const dañada = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from('no es una foto'),
      ]);
      await http()
        .put('/users/me/photo')
        .set(e.cliente)
        .attach('file', dañada, {
          filename: 'x.jpg',
          contentType: 'image/jpeg',
        })
        .expect(415);
      await http()
        .put('/users/me/photo')
        .set(e.cliente)
        .attach('file', PNG_REAL, {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(200);
    });
  });

  describe('idempotencia', () => {
    it('POST /incidents con la misma clave no duplica la incidencia', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.ON_THE_WAY,
        deliveryId: e.del1.deliveryId,
      });
      const clave = randomUUID();
      const cuerpo = {
        orderId: p.orderId,
        type: IncidentType.NO_SHOW,
        description: 'No estaba el cliente',
      };
      const a = await http()
        .post('/incidents')
        .set(e.chofer1)
        .set('Idempotency-Key', clave)
        .send(cuerpo)
        .expect(201);
      const b = await http()
        .post('/incidents')
        .set(e.chofer1)
        .set('Idempotency-Key', clave)
        .send(cuerpo)
        .expect(201);
      expect(b.body).toEqual(a.body);
      expect(await ds.getRepository(Incident).count()).toBe(1);
      // Con otro cuerpo, la misma clave es 422 y tampoco ejecuta.
      await http()
        .post('/incidents')
        .set(e.chofer1)
        .set('Idempotency-Key', clave)
        .send({ ...cuerpo, description: 'Otra cosa' })
        .expect(422);
      expect(await ds.getRepository(Incident).count()).toBe(1);
    });

    it('la misma clave en otra distribuidora no devuelve la respuesta de la primera', async () => {
      const e = await escenario();
      const clave = randomUUID();
      const pA = await pedido(e, { status: OrderStatus.ACCEPTED });
      // El pedido aceptado de B tiene un chofer de B (la clave foránea es por distribuidora).
      const choferB = await usuario('delivery', 'Chofer B');
      const delB = await ds.getRepository(Delivery).save({
        userId: choferB.user.userId,
        distributorId: e.dB.distributorId,
        validated: true,
        isEnabled: true,
      } as Partial<Delivery>);
      const pB = await pedido(e, {
        distributorId: e.dB.distributorId,
        status: OrderStatus.ACCEPTED,
        deliveryId: delB.deliveryId,
      });
      // Antes el super admin cambiaba de distribuidora con la MISMA clave. Con el
      // modo soporte nadie escribe en dos distribuidoras: el super admin no
      // escribe en ninguna (sin sesión 403; con sesión, sólo lectura), así que
      // la clave no puede cruzar de una a otra.
      for (const [pedidoId, cab] of [
        [pA.orderId, e.supEnA],
        [pB.orderId, e.supEnB],
      ] as const) {
        const r = await http()
          .patch(`/orders/${pedidoId}/cancel`)
          .set(cab)
          .set('Idempotency-Key', clave)
          .send({ reason: 'cancelo A' });
        expect(r.body).toMatchObject({
          statusCode: 403,
          code: 'SUPPORT_SESSION_REQUIRED',
        });
      }
      const estados = await ds.getRepository(Order).find({
        where: [{ orderId: pA.orderId }, { orderId: pB.orderId }],
      });
      expect(estados.map((o) => o.status)).toEqual([
        OrderStatus.ACCEPTED,
        OrderStatus.ACCEPTED,
      ]);
    });
  });

  describe('cobros manuales del administrador', () => {
    it('registra el cobro en efectivo con motivo, sin el chofer; queda auditado y en el historial', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.DELIVERED,
        deliveryId: e.del1.deliveryId,
        deliveredAt: new Date(),
      });
      await http()
        .patch(`/orders/${p.orderId}/payment/register-cash`)
        .set(e.adminA)
        .send({ reason: 'corto' })
        .expect(400);
      const res = await http()
        .patch(`/orders/${p.orderId}/payment/register-cash`)
        .set(e.adminA)
        .send({ reason: 'El chofer renunció antes de rendir' })
        .expect(200);
      expect(res.body).toMatchObject({
        paymentStatus: PaymentStatus.PAID,
        paymentConfirmedBy: e.adminAUserId,
        paymentResolutionNote: 'El chofer renunció antes de rendir',
      });
      // Repetido: no cambia nada.
      await http()
        .patch(`/orders/${p.orderId}/payment/register-cash`)
        .set(e.adminA)
        .send({ reason: 'El chofer renunció antes de rendir' })
        .expect(200);
      const historial = await ds
        .getRepository(OrderStatusHistory)
        .find({ where: { orderId: p.orderId } });
      expect(
        historial.filter((h) => h.reason?.includes('renunció')),
      ).toHaveLength(1);
      // Otra distribuidora: 404.
      await http()
        .patch(`/orders/${p.orderId}/payment/register-cash`)
        .set(e.adminB)
        .send({ reason: 'motivo de prueba suficiente' })
        .expect(404);
    });

    it('informa el impago por el chofer ausente y abre UNA incidencia', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.DELIVERED,
        deliveryId: e.del1.deliveryId,
        deliveredAt: new Date(),
      });
      const cuerpo = { reason: 'El chofer no informó que no cobró' };
      const r1 = await http()
        .patch(`/orders/${p.orderId}/payment/register-unpaid`)
        .set(e.adminA)
        .send(cuerpo)
        .expect(200);
      const r2 = await http()
        .patch(`/orders/${p.orderId}/payment/register-unpaid`)
        .set(e.adminA)
        .send(cuerpo)
        .expect(200);
      expect(
        (r1.body as { incident: { incident_id: string } }).incident.incident_id,
      ).toBe(
        (r2.body as { incident: { incident_id: string } }).incident.incident_id,
      );
      expect(await ds.getRepository(Incident).count()).toBe(1);
      expect(
        (await ds.getRepository(Order).findOneByOrFail({ orderId: p.orderId }))
          .paymentStatus,
      ).toBe(PaymentStatus.UNPAID);
    });

    it('la incidencia de un impago no se descarta ni se resuelve por la vía genérica; resolve-unpaid sí la cierra', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.DELIVERED,
        deliveryId: e.del1.deliveryId,
        deliveredAt: new Date(),
      });
      const informe = await http()
        .patch(`/orders/${p.orderId}/payment/register-unpaid`)
        .set(e.adminA)
        .send({ reason: 'El chofer no informó que no cobró' })
        .expect(200);
      const incidenciaId = (
        informe.body as { incident: { incident_id: string } }
      ).incident.incident_id;

      for (const status of ['discarded', 'resolved']) {
        await http()
          .patch(`/incidents/${incidenciaId}/resolve`)
          .set(e.adminA)
          .send({ status, resolutionNote: 'intento por la puerta genérica' })
          .expect(409);
      }
      expect(
        (
          await ds
            .getRepository(Incident)
            .findOneByOrFail({ incidentId: incidenciaId })
        ).status,
      ).toBe(IncidentStatus.OPEN);

      await http()
        .patch(`/orders/${p.orderId}/payment/resolve-unpaid`)
        .set(e.adminA)
        .send({ resolution: 'paid', note: 'pagó el lunes' })
        .expect(200);
      const cerrada = await ds
        .getRepository(Incident)
        .findOneByOrFail({ incidentId: incidenciaId });
      expect(cerrada.status).toBe(IncidentStatus.RESOLVED);
      expect(cerrada.resolutionNote).toBe('pagó el lunes');
    });

    it('carrera: resolve-unpaid y el descarte genérico en paralelo nunca dejan la incidencia pisada', async () => {
      const e = await escenario();
      for (let i = 0; i < 6; i++) {
        const p = await pedido(e, {
          status: OrderStatus.DELIVERED,
          deliveryId: e.del1.deliveryId,
          deliveredAt: new Date(),
        });
        const informe = await http()
          .patch(`/orders/${p.orderId}/payment/register-unpaid`)
          .set(e.adminA)
          .send({ reason: 'El chofer no informó que no cobró' })
          .expect(200);
        const incidenciaId = (
          informe.body as { incident: { incident_id: string } }
        ).incident.incident_id;
        const [resolver, descartar] = await Promise.all([
          http()
            .patch(`/orders/${p.orderId}/payment/resolve-unpaid`)
            .set(e.adminA)
            .send({ resolution: 'paid', note: 'pagó después' }),
          http()
            .patch(`/incidents/${incidenciaId}/resolve`)
            .set(e.adminA)
            .send({ status: 'discarded', resolutionNote: 'duplicada' }),
        ]);
        expect(resolver.status).toBe(200);
        expect(descartar.status).toBe(409);
        const inc = await ds
          .getRepository(Incident)
          .findOneByOrFail({ incidentId: incidenciaId });
        expect(inc.status).toBe(IncidentStatus.RESOLVED);
        expect(inc.resolutionNote).toBe('pagó después');
      }
    });
  });

  describe('transferencias (sólo lo histórico)', () => {
    async function entregadaPorTransferencia(e: E) {
      return pedido(e, {
        status: OrderStatus.DELIVERED,
        deliveryId: e.del1.deliveryId,
        deliveredAt: new Date(),
        paymentMethod: PaymentMethod.TRANSFER,
        paymentType: PaymentType.ONLINE,
        totalAmount: 1100,
        paymentSurchargeAmount: 100,
      });
    }
    const hoy = () => diaArgentino();

    it('un pedido viejo por transferencia sigue en cobros y no suma a las ventas', async () => {
      const e = await escenario();
      await entregadaPorTransferencia(e);

      const r = await http()
        .get(`/reports/collections?from=${hoy()}&to=${hoy()}`)
        .set(e.adminA)
        .expect(200);
      expect(
        (r.body as { pendingTransfer: { totalAmount: number } }).pendingTransfer
          .totalAmount,
      ).toBe(1100);
      const ventas = await http()
        .get('/orders/stats/summary')
        .set(e.adminA)
        .expect(200);
      expect((ventas.body as { sales: { total: number } }).sales.total).toBe(0);
    });

    it('confirmar la transferencia ya no existe: 404', async () => {
      const e = await escenario();
      const t = await entregadaPorTransferencia(e);
      await http()
        .patch(`/orders/${t.orderId}/payment/confirm-transfer`)
        .set(e.adminA)
        .send({ received: true, reason: 'motivo suficientemente largo' })
        .expect(404);
    });
  });

  describe('historial de estados', () => {
    it('registra el alta y cada transición, con quién y el motivo', async () => {
      const e = await escenario();
      const creado = await http()
        .post('/orders')
        .set(e.cliente)
        .send({
          customerId: e.cli.userId,
          addressId: e.dir.addressId,
          paymentMethod: 'cash',
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: 1,
              unitPrice: 1000,
            },
          ],
        })
        .expect(201);
      const id = (creado.body as { order_id: string }).order_id;
      await http()
        .patch(`/orders/${id}/assign/${e.del1.deliveryId}`)
        .set(e.adminA)
        .expect(200);
      await http()
        .patch(`/orders/${id}/cancel`)
        .set(e.cliente)
        .send({ reason: 'Me equivoqué de dirección' })
        .expect(200);

      const filas = await ds
        .getRepository(OrderStatusHistory)
        .find({ where: { orderId: id }, order: { changedAt: 'ASC' } });
      expect(filas.map((f) => [f.fromStatus, f.toStatus])).toEqual([
        [null, OrderStatus.PENDING],
        [OrderStatus.PENDING, OrderStatus.ACCEPTED],
        [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
      ]);
      expect(filas[0].changedByUserId).toBe(e.cli.userId);
      expect(filas[1].changedByUserId).toBe(e.adminAUserId);
      expect(filas[2]).toMatchObject({
        changedByUserId: e.cli.userId,
        reason: 'Me equivoqué de dirección',
      });
    });

    it('la entrega manual deja UNA fila con el motivo', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.ON_THE_WAY,
        deliveryId: e.del1.deliveryId,
      });
      await ds.getRepository(OrderStatusHistory).clear();
      await http()
        .patch(`/orders/${p.orderId}/status`)
        .set(e.adminA)
        .send({
          status: 'delivered',
          reason: 'El cliente no tiene celular: confirmó por teléfono',
        })
        .expect(200);
      const filas = await ds
        .getRepository(OrderStatusHistory)
        .find({ where: { orderId: p.orderId } });
      expect(filas).toHaveLength(1);
      expect(filas[0]).toMatchObject({
        fromStatus: OrderStatus.ON_THE_WAY,
        toStatus: OrderStatus.DELIVERED,
        changedByUserId: e.adminAUserId,
        reason: 'El cliente no tiene celular: confirmó por teléfono',
      });
    });
  });

  describe('cotización', () => {
    it('POST /orders/quote coincide con el total del pedido creado con el mismo cuerpo', async () => {
      const e = await escenario();
      for (const paymentMethod of ['cash', 'transfer', 'mercadopago']) {
        const cuerpo = {
          customerId: e.cli.userId,
          addressId: e.dir.addressId,
          paymentMethod,
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: 3,
              unitPrice: 1,
            },
          ],
        };
        const cotizacion = await http()
          .post('/orders/quote')
          .set(e.cliente)
          .send(cuerpo)
          .expect(200);
        const creado = await http()
          .post('/orders')
          .set(e.cliente)
          .send(cuerpo)
          .expect(201);
        const q = cotizacion.body as {
          total: number;
          subtotal: number;
          zoneSurcharge: number;
          paymentSurcharge: number;
        };
        expect(q.total).toBe(
          (creado.body as { total_amount: number }).total_amount,
        );
        expect(q.subtotal).toBe(3000);
        expect(q.subtotal + q.zoneSurcharge + q.paymentSurcharge).toBeCloseTo(
          q.total,
          2,
        );
      }
    });

    it('no escribe nada ni toca el stock', async () => {
      const e = await escenario();
      await http()
        .post('/orders/quote')
        .set(e.cliente)
        .send({
          paymentMethod: 'cash',
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: 5,
              unitPrice: 0,
            },
          ],
        })
        .expect(200);
      expect(await ds.getRepository(Order).count()).toBe(0);
      const g = await ds
        .getRepository(GasCylinder)
        .findOneByOrFail({ gasCylinderId: e.garrafa.gasCylinderId });
      expect(g.stock).toBe(50);
    });

    it('rechaza lo que el alta rechaza (sin stock) y el chofer no cotiza', async () => {
      const e = await escenario();
      const cuerpo = {
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: 999,
            unitPrice: 0,
          },
        ],
      };
      await http()
        .post('/orders/quote')
        .set(e.cliente)
        .send(cuerpo)
        .expect(400);
      await http()
        .post('/orders/quote')
        .set(e.chofer1)
        .send(cuerpo)
        .expect(403);
    });
  });

  describe('datos del chofer en el pedido', () => {
    it('el cliente dueño y el admin ven nombre, teléfono y calificación mientras el pedido está activo', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.ON_THE_WAY,
        deliveryId: e.del1.deliveryId,
        vehicleCarId: null,
      });
      for (const [estrellas, orden] of [
        [5, p],
        [
          4,
          await pedido(e, {
            status: OrderStatus.DELIVERED,
            deliveryId: e.del1.deliveryId,
          }),
        ],
      ] as const) {
        await ds.getRepository(Rating).save({
          orderId: orden.orderId,
          distributorId: e.dA.distributorId,
          fromUserId: e.cli.userId,
          toUserId: e.chofer1UserId,
          fromRole: RaterRole.CUSTOMER,
          stars: estrellas,
          hidden: false,
        } as Partial<Rating>);
      }
      const dueno = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.cliente)
        .expect(200);
      expect((dueno.body as { driver: unknown }).driver).toEqual({
        userId: e.chofer1UserId,
        fullName: 'Ana Chofer',
        phoneNumber: expect.any(String) as string,
        ratingAverage: 4.5,
        ratingCount: 2,
        location: null,
      });
      const admin = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.adminA)
        .expect(200);
      expect(
        (admin.body as { driver: { fullName: string } }).driver.fullName,
      ).toBe('Ana Chofer');
      // El chofer, que es el chofer, no recibe el bloque; otro cliente no ve el pedido.
      const delChofer = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.chofer1)
        .expect(200);
      expect((delChofer.body as { driver: unknown }).driver).toBeNull();
      await http().get(`/orders/${p.orderId}`).set(e.cliente2).expect(404);
    });

    it('con el pedido cerrado no expone el teléfono', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.DELIVERED,
        deliveryId: e.del1.deliveryId,
        deliveredAt: new Date(),
      });
      const res = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.cliente)
        .expect(200);
      expect((res.body as { driver: unknown }).driver).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('phoneNumber');
    });
  });

  describe('quién canceló y última ubicación del chofer', () => {
    async function creadoPorApi(e: E) {
      const res = await http()
        .post('/orders')
        .set(e.cliente)
        .send({
          customerId: e.cli.userId,
          addressId: e.dir.addressId,
          paymentMethod: 'cash',
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              quantity: 1,
              unitPrice: 1000,
            },
          ],
        })
        .expect(201);
      return (res.body as { order_id: string }).order_id;
    }
    const cancelledBy = async (h: Headers, id: string) =>
      (
        (await http().get(`/orders/${id}`).set(h).expect(200)).body as {
          cancelledBy: string | null;
        }
      ).cancelledBy;

    it('GET /orders/:id dice quién canceló: cliente, admin o sistema', async () => {
      const e = await escenario();
      const porCliente = await creadoPorApi(e);
      await http()
        .patch(`/orders/${porCliente}/cancel`)
        .set(e.cliente)
        .send({ reason: 'cambié de idea' })
        .expect(200);
      const porAdmin = await creadoPorApi(e);
      await http()
        .patch(`/orders/${porAdmin}/cancel`)
        .set(e.adminA)
        .send({ reason: 'sin cobertura hoy' })
        .expect(200);
      const porSistema = await creadoPorApi(e);
      // El cron de vencimiento cancela sin usuario en el request.
      await forzarEstado(
        ds,
        `UPDATE "order" SET status = 'cancelled', "cancellationReason" = 'Venció sin chofer' WHERE order_id = $1`,
        [porSistema],
      );
      await ds.getRepository(OrderStatusHistory).insert({
        orderId: porSistema,
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.CANCELLED,
        changedByUserId: null,
        reason: 'Pago vencido',
      });

      expect(await cancelledBy(e.cliente, porCliente)).toBe('customer');
      expect(await cancelledBy(e.cliente, porAdmin)).toBe('admin');
      expect(await cancelledBy(e.cliente, porSistema)).toBe('system');
      expect(await cancelledBy(e.adminA, porCliente)).toBe('customer');
      const activo = await creadoPorApi(e);
      expect(await cancelledBy(e.cliente, activo)).toBeNull();
    });

    it('el bloque driver trae la última ubicación con su hora; sin posición, null', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        status: OrderStatus.ON_THE_WAY,
        deliveryId: e.del1.deliveryId,
      });
      const sin = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.cliente)
        .expect(200);
      expect(
        (sin.body as { driver: { location: unknown } }).driver.location,
      ).toBeNull();

      const antes = Date.now();
      const redis = env.app.get(RedisService);
      await redis.updateDriverLocation(e.chofer1UserId, -34.6101, -58.4012);
      // El chofer lleva OTRO pedido: su posición no es de este cliente.
      await redis.setDriverActiveOrder(e.chofer1UserId, {
        orderId: randomUUID(),
        customerId: e.cli2.userId,
      });
      const ajeno = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.cliente)
        .expect(200);
      expect(
        (ajeno.body as { driver: { location: unknown } }).driver.location,
      ).toBeNull();
      await redis.setDriverActiveOrder(e.chofer1UserId, {
        orderId: p.orderId,
        customerId: e.cli.userId,
      });
      const con = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.cliente)
        .expect(200);
      const loc = (
        con.body as {
          driver: { location: { lat: number; lng: number; at: string } };
        }
      ).driver.location;
      expect(loc.lat).toBeCloseTo(-34.6101, 3);
      expect(loc.lng).toBeCloseTo(-58.4012, 3);
      expect(new Date(loc.at).getTime()).toBeGreaterThanOrEqual(antes - 1000);

      // Cerrado: no se expone nada del chofer.
      await forzarEstado(
        ds,
        `UPDATE "order" SET status = 'delivered', "deliveredAt" = now() WHERE order_id = $1`,
        [p.orderId],
      );
      const cerrado = await http()
        .get(`/orders/${p.orderId}`)
        .set(e.cliente)
        .expect(200);
      expect((cerrado.body as { driver: unknown }).driver).toBeNull();
    });
  });

  describe('aceptar y volver con el camión', () => {
    let numeroDeCarga = 0;
    async function cargaEnRuta(e: E): Promise<TruckLoad> {
      const ubicacion = await env.app
        .get(StockLocationService)
        .ubicacionDeVehiculo(ds.manager, e.dA.distributorId, e.carId);
      const carga = await ds.getRepository(TruckLoad).save({
        distributorId: e.dA.distributorId,
        number: (numeroDeCarga += 1),
        carId: e.carId,
        deliveryId: e.del1.deliveryId,
        originLocationId: ubicacion.locationId,
        businessDate: diaArgentino(),
        status: TruckLoadStatus.ON_ROUTE,
        departedAt: new Date(),
        openedByUserId: e.adminAUserId,
      } as Partial<TruckLoad>);
      await ds.getRepository(TruckLoadItem).save({
        loadId: carga.loadId,
        gasCylinderId: e.garrafa.gasCylinderId,
        loadedFull: 5,
        loadedEmpty: 0,
      } as Partial<TruckLoadItem>);
      return carga;
    }
    const declarar = (e: E, e2: E['adminA'], loadId: string) =>
      http()
        .patch(`/truck-loads/${loadId}/return`)
        .set(e2)
        .send({
          items: [
            {
              gasCylinderId: e.garrafa.gasCylinderId,
              declaredFull: 5,
              declaredEmpty: 0,
            },
          ],
        });
    const estadoDe = async (loadId: string) =>
      (await ds.getRepository(TruckLoad).findOneByOrFail({ loadId })).status;

    /** Una vuelta en curso: la carga tomada FOR UPDATE y ya `returned`, sin commit. */
    async function vueltaSinCommit(loadId: string) {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      await qr.query(`SELECT 1 FROM truck_load WHERE load_id = $1 FOR UPDATE`, [
        loadId,
      ]);
      await forzarEstado(
        qr,
        `UPDATE truck_load SET status = 'returned', returned_at = now() WHERE load_id = $1`,
        [loadId],
      );
      return qr;
    }
    const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('con la vuelta en curso, la aceptación del chofer espera y, al confirmarse la vuelta, se rechaza', async () => {
      const e = await escenario();
      const carga = await cargaEnRuta(e);
      const p = await pedido(e);
      const qr = await vueltaSinCommit(carga.loadId);
      let terminado = false;
      const aceptacion = http()
        .patch(`/orders/${p.orderId}/status`)
        .set(e.chofer1)
        .send({ status: 'accepted' })
        .then((r) => {
          terminado = true;
          return r;
        });
      await esperar(1500);
      // Sin el lock la aceptación leería la carga `on_route` y ya habría terminado.
      expect(terminado).toBe(false);
      await qr.commitTransaction();
      await qr.release();
      const res = await aceptacion;
      expect(res.status).toBe(400);
      expect(
        (await ds.getRepository(Order).findOneByOrFail({ orderId: p.orderId }))
          .status,
      ).toBe(OrderStatus.PENDING);
    });

    it('con la vuelta en curso, la asignación manual del admin espera y se rechaza', async () => {
      const e = await escenario();
      const carga = await cargaEnRuta(e);
      const p = await pedido(e);
      const qr = await vueltaSinCommit(carga.loadId);
      let terminado = false;
      const asignacion = http()
        .patch(`/orders/${p.orderId}/assign/${e.del1.deliveryId}`)
        .set(e.adminA)
        .then((r) => {
          terminado = true;
          return r;
        });
      await esperar(1500);
      expect(terminado).toBe(false);
      await qr.commitTransaction();
      await qr.release();
      expect((await asignacion).status).toBe(400);
      expect(
        (await ds.getRepository(Order).findOneByOrFail({ orderId: p.orderId }))
          .status,
      ).toBe(OrderStatus.PENDING);
    });

    it('aceptar y volver en paralelo nunca dejan un pedido aceptado sobre una carga devuelta', async () => {
      const e = await escenario();
      for (let i = 0; i < 8; i++) {
        const carga = await cargaEnRuta(e);
        const p = await pedido(e);
        const [aceptar, volver] = await Promise.all([
          http()
            .patch(`/orders/${p.orderId}/status`)
            .set(e.chofer1)
            .send({ status: 'accepted' }),
          declarar(e, e.adminA, carga.loadId),
        ]);
        const pedidoFinal = await ds
          .getRepository(Order)
          .findOneByOrFail({ orderId: p.orderId });
        const estadoCarga = await estadoDe(carga.loadId);
        const aceptado = pedidoFinal.status === OrderStatus.ACCEPTED;
        const devuelta = estadoCarga === TruckLoadStatus.RETURNED;
        // O se aceptó (y la vuelta se rechazó por pedido en curso), o volvió (y
        // la aceptación se rechazó): nunca las dos cosas.
        expect(aceptado && devuelta).toBe(false);
        expect([aceptar.status, volver.status].some((c) => c === 200)).toBe(
          true,
        );
        // Deja el escenario limpio para la vuelta siguiente.
        await forzarEstado(
          ds,
          `UPDATE truck_load SET status = 'cancelled', cancel_reason = 'Fin de la vuelta de la prueba', closed_at = now() WHERE load_id = $1`,
          [carga.loadId],
        );
        await forzarEstado(
          ds,
          `UPDATE "order" SET status = 'cancelled', "cancellationReason" = 'Cancelado en la prueba' WHERE order_id = $1`,
          [p.orderId],
        );
      }
    });
  });

  describe('verificaciones de la colección de Postman', () => {
    it('un chofer no crea incidencias sobre el pedido de otro chofer ni sobre uno sin asignar', async () => {
      const e = await escenario();
      const ajeno = await pedido(e, {
        status: OrderStatus.ON_THE_WAY,
        deliveryId: e.del2.deliveryId,
      });
      const sinAsignar = await pedido(e);
      const propio = await pedido(e, {
        status: OrderStatus.ON_THE_WAY,
        deliveryId: e.del1.deliveryId,
      });
      const incidencia = (orderId: string) =>
        http().post('/incidents').set(e.chofer1).send({
          orderId,
          type: IncidentType.OTHER,
          description: 'prueba de pertenencia',
        });
      await incidencia(ajeno.orderId).expect(404);
      await incidencia(sinAsignar.orderId).expect(404);
      await incidencia(propio.orderId).expect(201);
      expect(await ds.getRepository(Incident).count()).toBe(1);
    });

    it('POST /orders/:id/reject responde 200 y un pedido inexistente es 404', async () => {
      const e = await escenario();
      const manual = await pedido(e, {
        status: OrderStatus.ACCEPTED,
        deliveryId: e.del1.deliveryId,
      });
      const ok = await http()
        .post(`/orders/${manual.orderId}/reject`)
        .set(e.chofer1)
        .expect(200);
      expect(ok.body).toEqual({ rejected: true });
      await http()
        .post(`/orders/${randomUUID()}/reject`)
        .set(e.chofer1)
        .expect(404);
    });

    it('el reenvío manual de la confirmación ya no es del super admin sin sesión (D6: escribe sobre la operación)', async () => {
      const e = await escenario();
      const r = await http()
        .post('/notifications/order-confirmation')
        .set(e.supSinHeader)
        .send({ customerId: randomUUID(), orderId: randomUUID() });
      expect(r.body).toMatchObject({
        statusCode: 403,
        code: 'SUPPORT_SESSION_REQUIRED',
      });
    });

    it('POST /user-address: el cliente crea con su token; el user_id de otro es 403', async () => {
      const e = await escenario();
      const alta = {
        street: 'Mitre 1',
        city: 'Posadas',
        latitude: '-27.4',
        longitude: '-55.9',
      };
      const sin = await http()
        .post('/user-address')
        .set(e.cliente)
        .send(alta)
        .expect(201);
      expect((sin.body as { user_id: string }).user_id).toBe(e.cli.userId);
      await http()
        .post('/user-address')
        .set(e.cliente)
        .send({ ...alta, user_id: e.cli.userId })
        .expect(201);
      await http()
        .post('/user-address')
        .set(e.cliente)
        .send({ ...alta, user_id: e.cli2.userId })
        .expect(403);
    });
  });

  describe('idempotencia en subidas multipart', () => {
    it('la misma clave con otro archivo es 422 (el archivo entra en la huella); con el mismo, la respuesta guardada', async () => {
      const e = await escenario();
      const entregado = await pedido(e, { status: OrderStatus.DELIVERED });
      const claim = await http().post('/claims').set(e.cliente).send({
        orderId: entregado.orderId,
        customerId: e.cli.userId,
        reason: 'producto dañado',
        description: 'foto con idempotencia',
      });
      const id =
        (claim.body as { claimId?: string }).claimId ??
        (claim.body as { claim_id?: string }).claim_id;
      const clave = randomUUID();
      const subir = (archivo: Buffer) =>
        http()
          .post(`/claims/${id}/photo`)
          .set(e.cliente)
          .set('Idempotency-Key', clave)
          .attach('file', archivo, {
            filename: 'f.png',
            contentType: 'image/png',
          });
      const primera = await subir(PNG_REAL).expect(201);
      const otraImagen = await imagenesDePrueba.png(true);
      await subir(otraImagen).expect(422);
      const repetida = await subir(PNG_REAL).expect(201);
      expect(repetida.body).toEqual(primera.body);
      // Sólo se guardó una foto.
      const fila = await ds
        .getRepository(Claim)
        .findOneByOrFail({ claimId: id as string });
      expect(fila.photoKey).toBeTruthy();
    });
  });

  describe('imágenes enormes', () => {
    it('una foto de 49 MP se rechaza con 413 sin subirse', async () => {
      const e = await escenario();
      const enorme = await sharp({
        create: {
          width: 7000,
          height: 7000,
          channels: 3,
          background: { r: 9, g: 9, b: 9 },
        },
      })
        .jpeg({ quality: 20 })
        .withMetadata({ orientation: 6 })
        .toBuffer();
      await http()
        .put('/users/me/photo')
        .set(e.cliente)
        .attach('file', enorme, {
          filename: 'e.jpg',
          contentType: 'image/jpeg',
        })
        .expect(413);
      const fila = await ds
        .getRepository(User)
        .findOneByOrFail({ userId: e.cli.userId });
      expect(fila.photoKey).toBeNull();
    });
  });
  describe('rutas por calles de un pedido', () => {
    let osrm: Server;
    let pedidosAlOsrm: string[];
    const POLILINEA = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

    beforeAll(async () => {
      pedidosAlOsrm = [];
      osrm = createServer((req, res) => {
        pedidosAlOsrm.push(req.url ?? '');
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            code: 'Ok',
            routes: [{ distance: 4621, duration: 465, geometry: POLILINEA }],
          }),
        );
      });
      await new Promise<void>((ok) => osrm.listen(0, '127.0.0.1', ok));
      process.env.OSRM_BASE_URL = `http://127.0.0.1:${(osrm.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      delete process.env.OSRM_BASE_URL;
      await new Promise((ok) => osrm.close(ok));
    });

    beforeEach(() => {
      pedidosAlOsrm.length = 0;
    });

    async function enCamino(
      e: E,
      estado = OrderStatus.ON_THE_WAY,
      posicion: [number, number] = [-34.6101, -58.4012],
    ) {
      const p = await pedido(e, {
        status: estado,
        deliveryId: e.del1.deliveryId,
      });
      await ds.query(
        `UPDATE user_address SET location = ST_SetSRID(ST_MakePoint(-58.3816, -34.6037), 4326) WHERE address_id = $1`,
        [e.dir.addressId],
      );
      const redis = env.app.get(RedisService);
      await redis.updateDriverLocation(e.chofer1UserId, ...posicion);
      await redis.setDriverActiveOrder(e.chofer1UserId, {
        orderId: p.orderId,
        customerId: e.cli.userId,
      });
      return p;
    }

    it('el cliente dueño con el pedido en camino: origen = posición del chofer, destino = dirección del pedido', async () => {
      const e = await escenario();
      const p = await enCamino(e);
      const r = await http()
        .get(`/routes/driving?orderId=${p.orderId}`)
        .set(e.cliente)
        .expect(200);
      expect(r.body).toMatchObject({
        provider: 'osrm',
        distanceMeters: 4621,
        durationSeconds: 465,
      });
      expect(pedidosAlOsrm).toHaveLength(1);
      const tramo =
        /driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?/.exec(
          pedidosAlOsrm[0],
        );
      expect(tramo?.slice(1).map(Number)).toEqual([
        expect.closeTo(-58.4012, 3),
        expect.closeTo(-34.6101, 3),
        -58.3816,
        -34.6037,
      ]);
    });

    it('no es un proxy: sin pedido, pedido ajeno, rol sin acceso o parámetros de más se rechazan y no llegan al proveedor', async () => {
      const e = await escenario();
      const p = await enCamino(e);
      await http().get('/routes/driving').set(e.cliente).expect(400);
      await http()
        .get(`/routes/driving?orderId=${randomUUID()}`)
        .set(e.cliente)
        .expect(404);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}`)
        .set(e.cliente2)
        .expect(404);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}`)
        .set(e.chofer2)
        .expect(404);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}`)
        .set(e.adminA)
        .expect(403);
      // El destino ya no se elige: `to` no existe.
      await http()
        .get(`/routes/driving?orderId=${p.orderId}&to=-34.7,-58.5`)
        .set(e.cliente)
        .expect(400);
      expect(pedidosAlOsrm).toHaveLength(0);
    });

    it('el cliente espera a que el chofer salga; el chofer puede desde que aceptó', async () => {
      const e = await escenario();
      const p = await enCamino(e, OrderStatus.ACCEPTED);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}`)
        .set(e.cliente)
        .expect(403);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}`)
        .set(e.chofer1)
        .expect(200);
    });

    it('`from` se acepta cerca de la posición del chofer y se rechaza lejos; sin posición reciente, 409', async () => {
      const e = await escenario();
      const p = await enCamino(e);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}&from=-34.6103,-58.4012`)
        .set(e.chofer1)
        .expect(200);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}&from=-34.7000,-58.5000`)
        .set(e.chofer1)
        .expect(400);
      await env.app.get(RedisService).removeDriver(e.chofer1UserId);
      await http()
        .get(`/routes/driving?orderId=${p.orderId}&from=-34.6103,-58.4012`)
        .set(e.chofer1)
        .expect(409);
    });

    it('el cupo diario por usuario corta con 429; lo que sale de la caché no gasta cupo', async () => {
      const e = await escenario();
      // Una posición que ningún otro test usó: la caché de 60 s está en Redis.
      const p = await enCamino(e, OrderStatus.ON_THE_WAY, [-34.7, -58.5]);
      const pedir = () =>
        http().get(`/routes/driving?orderId=${p.orderId}`).set(e.chofer1);
      const redis = env.app.get(RedisService);
      const clave = `routes:dia:usuario:${e.chofer1UserId}`;
      await pedir().expect(200);
      await pedir().expect(200); // misma ruta: caché, no cuenta
      expect(pedidosAlOsrm).toHaveLength(1);
      expect(await redis.get(clave)).toBe('1');
      // Con el tope del día agotado (100 por defecto):
      await redis.setex(clave, 3600, '100');
      // Otra posición: otra ruta, llega al proveedor y supera el tope.
      await env.app
        .get(RedisService)
        .updateDriverLocation(e.chofer1UserId, -34.71, -58.51);
      await pedir().expect(429);
      expect(pedidosAlOsrm).toHaveLength(1);
    });
  });

  describe('consulta de existencia de cuentas', () => {
    it('POST /users/check-exists tiene un cupo bajo por IP (429 a la undécima)', async () => {
      const intento = () =>
        http()
          .post('/users/check-exists')
          .send({ email: `nadie.${randomUUID().slice(0, 6)}@splg.local` });
      for (let i = 0; i < 10; i += 1) {
        await intento().expect(200);
      }
      await intento().expect(429);
    });
  });
});
