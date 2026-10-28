/**
 * Comprobante de transferencia (API v2) contra Postgres, Redis y MinIO reales:
 * el cliente sube el comprobante de SU pedido, el admin lo ve, el historial
 * deja la nota, el panel se entera por socket y la distribuidora publica sus
 * datos bancarios. También los owner types de adjuntos que antes daban 400 y
 * los documentos Word/Excel/CSV.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';
import { startMinio, TestMinio } from './setup/minio';
import { PNG_REAL } from './setup/imagenes';
import { fechasSegunEstado } from './setup/pedido-valido';
import { zipDePrueba } from '../../src/common/utils/zip-de-prueba';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { DriverSettlement } from '../../src/driver-settlement/entities/driver-settlement.entity';
import { DriverSettlementStatus } from '../../src/driver-settlement/domain/driver-settlement.enums';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';
import { OrderStatusHistory } from '../../src/order/entities/order-status-history.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '../../src/order/entities/order.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';

type Headers = Record<string, string>;

const CBU = '0170099220000067797370';
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('Comprobante de transferencia y datos bancarios (e2e, API v2)', () => {
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

  async function usuario(
    tipo: 'customer' | 'admin' | 'super_admin' | 'delivery',
    nombre: string,
  ) {
    seq += 1;
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: tipo } })) ??
      (await roles.save({ type: tipo } as Partial<Role>));
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: nombre,
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>);
    return { user, email };
  }

  async function escenario() {
    seq += 1;
    const dA = await ds.getRepository(Distributor).save({
      name: 'Dist A',
      slug: `dist-a-${seq}-${randomUUID().slice(0, 4)}`,
    } as Partial<Distributor>);
    const dB = await ds.getRepository(Distributor).save({
      name: 'Dist B',
      slug: `dist-b-${seq}-${randomUUID().slice(0, 4)}`,
    } as Partial<Distributor>);
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
      cli: cli.user,
      dir,
      adminA: h(adminA.email, 'panel-app'),
      adminB: h(adminB.email, 'panel-app'),
      supSinHeader: h(sup.email, 'panel-app'),
      supEnA: h(sup.email, 'panel-app', { 'X-Distributor': dA.slug }),
      cliente: h(cli.email, 'customer-app', { 'X-Distributor': dA.slug }),
      cliente2: h(cli2.email, 'customer-app', { 'X-Distributor': dA.slug }),
    };
  }
  type E = Awaited<ReturnType<typeof escenario>>;

  function pedido(e: E, parcial: Partial<Order> = {}): Promise<Order> {
    return ds.getRepository(Order).save({
      customerId: e.cli.userId,
      distributorId: e.dA.distributorId,
      addressId: e.dir.addressId,
      status: OrderStatus.PENDING,
      paymentMethod: PaymentMethod.TRANSFER,
      paymentType: PaymentType.ONLINE,
      paymentStatus: PaymentStatus.PENDING,
      totalAmount: 1000,
      subtotalItems: 1000,
      ...fechasSegunEstado(parcial.status ?? OrderStatus.PENDING),
      ...parcial,
    } as Partial<Order>) as Promise<Order>;
  }

  const subirComprobante = (
    e: E,
    orderId: string,
    quien: Headers,
    archivo?: { buffer: Buffer; nombre: string; mime: string },
  ) => {
    const req = http()
      .post(`/v2/orders/${orderId}/transfer-receipt`)
      .set(quien);
    return archivo
      ? req.attach('file', archivo.buffer, {
          filename: archivo.nombre,
          contentType: archivo.mime,
        })
      : req;
  };
  const PNG = { buffer: PNG_REAL, nombre: 'comp.png', mime: 'image/png' };

  describe('datos bancarios de la distribuidora', () => {
    it('el admin los carga con validación, el cliente los lee por SU pedido y nadie ve los de otra distribuidora', async () => {
      const e = await escenario();
      const p = await pedido(e);

      await http()
        .put('/v2/distributor/bank-details')
        .set(e.adminA)
        .send({ cbu: '0170099220000067797371' })
        .expect(400);
      await http()
        .put('/v2/distributor/bank-details')
        .set(e.adminA)
        .send({ alias: 'corto' })
        .expect(400);
      await http()
        .put('/v2/distributor/bank-details')
        .set(e.supSinHeader)
        .send({ alias: 'garrafas.splg' })
        .expect(400);

      const guardado = await http()
        .put('/v2/distributor/bank-details')
        .set(e.adminA)
        .send({ cbu: CBU, alias: 'garrafas.splg', holder: 'Dist A S.A.' })
        .expect(200);
      expect(guardado.body).toEqual({
        cbu: CBU,
        alias: 'garrafas.splg',
        holder: 'Dist A S.A.',
      });

      const vistoPorB = await http()
        .get('/v2/distributor/bank-details')
        .set(e.adminB)
        .expect(200);
      expect(vistoPorB.body).toEqual({ cbu: null, alias: null, holder: null });

      const vistoPorElCliente = await http()
        .get(`/v2/orders/${p.orderId}/bank-details`)
        .set(e.cliente)
        .expect(200);
      expect(vistoPorElCliente.body).toEqual(guardado.body);
      await http()
        .get(`/v2/orders/${p.orderId}/bank-details`)
        .set(e.cliente2)
        .expect(404);
      await http()
        .get(`/v2/orders/${p.orderId}/bank-details`)
        .set(e.adminA)
        .expect(403);

      // Reemplaza: lo que no se manda queda sin cargar.
      const parcial = await http()
        .put('/v2/distributor/bank-details')
        .set(e.adminA)
        .send({ alias: 'garrafas.splg' })
        .expect(200);
      expect(parcial.body).toEqual({
        cbu: null,
        alias: 'garrafas.splg',
        holder: null,
      });
    });

    it('la base también frena un CBU inválido que se escape del back', async () => {
      const e = await escenario();
      await expect(
        ds
          .getRepository(Distributor)
          .update(e.dA.distributorId, { bankCbu: '0170099220000067797371' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('CHK_distributor_cbu') as string,
      });
      await expect(
        ds
          .getRepository(Distributor)
          .update(e.dA.distributorId, { bankAlias: 'a b' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('CHK_distributor_alias') as string,
      });
    });

    it('un pedido que no es por transferencia no muestra datos bancarios (400)', async () => {
      const e = await escenario();
      const p = await pedido(e, {
        paymentMethod: PaymentMethod.CASH,
        paymentType: PaymentType.CASH,
      });
      await http()
        .get(`/v2/orders/${p.orderId}/bank-details`)
        .set(e.cliente)
        .expect(400);
    });
  });

  describe('comprobante', () => {
    it('el cliente lo sube, queda la nota, el panel se entera y el admin lo ve con URL firmada', async () => {
      const e = await escenario();
      const p = await pedido(e);
      const notifyAdmins = jest.spyOn(
        env.app.get(RealtimeDispatchPort, { strict: false }),
        'notifyAdmins',
      );

      const res = await subirComprobante(e, p.orderId, e.cliente, PNG).expect(
        201,
      );
      expect(res.body).toMatchObject({
        ownerType: 'order',
        ownerId: p.orderId,
        label: 'Comprobante de transferencia',
        mimeType: 'image/png',
        uploadedByUserId: e.cli.userId,
      });
      expect(res.body).not.toHaveProperty('storageKey');

      expect(notifyAdmins).toHaveBeenCalledWith(
        'order:transfer-receipt-uploaded',
        expect.objectContaining({
          orderId: p.orderId,
          customerId: e.cli.userId,
          attachmentId: (res.body as { attachmentId: string }).attachmentId,
        }),
        e.dA.distributorId,
      );

      const notas = (
        await ds
          .getRepository(OrderStatusHistory)
          .find({ where: { orderId: p.orderId } })
      ).filter((fila) => fila.reason !== null);
      expect(notas).toHaveLength(1);
      expect(notas[0]).toMatchObject({
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.PENDING,
        changedByUserId: e.cli.userId,
        reason: 'El cliente subió el comprobante de la transferencia',
      });

      const lista = await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.adminA)
        .expect(200);
      const items = lista.body as Array<{ url: string; mimeType: string }>;
      expect(items).toHaveLength(1);
      const bajado = await fetch(items[0].url);
      expect(bajado.status).toBe(200);
      expect(Buffer.from(await bajado.arrayBuffer()).length).toBeGreaterThan(0);

      // Lo ve el cliente dueño y el super admin con X-Distributor.
      await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.cliente)
        .expect(200);
      await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.supEnA)
        .expect(200);
      await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.supSinHeader)
        .expect(400);
    });

    it('aislamiento: otro cliente y otra distribuidora no suben ni ven el comprobante (404)', async () => {
      const e = await escenario();
      const p = await pedido(e);
      await subirComprobante(e, p.orderId, e.cliente2, PNG).expect(404);
      await subirComprobante(e, p.orderId, e.cliente, PNG).expect(201);
      await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.cliente2)
        .expect(404);
      await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.adminB)
        .expect(404);
    });

    it('un admin no sube por el endpoint del cliente (403)', async () => {
      const e = await escenario();
      const p = await pedido(e);
      await subirComprobante(e, p.orderId, e.adminA, PNG).expect(403);
    });

    it('rechaza lo que no es imagen o PDF, el HTML disfrazado y la falta de archivo', async () => {
      const e = await escenario();
      const p = await pedido(e);
      await subirComprobante(e, p.orderId, e.cliente).expect(400);
      await subirComprobante(e, p.orderId, e.cliente, {
        buffer: zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
        nombre: 'c.docx',
        mime: DOCX,
      }).expect(415);
      await subirComprobante(e, p.orderId, e.cliente, {
        buffer: Buffer.from('<html></html>'),
        nombre: 'c.png',
        mime: 'image/png',
      }).expect(415);
      expect(
        await ds.query('SELECT count(*)::int AS n FROM attachment'),
      ).toEqual([{ n: 0 }]);
    });

    it('sólo con el pago pendiente o no recibido, en una transferencia no cancelada', async () => {
      const e = await escenario();
      const mp = await pedido(e, {
        paymentMethod: PaymentMethod.MERCADOPAGO,
        paymentType: PaymentType.ONLINE,
      });
      await subirComprobante(e, mp.orderId, e.cliente, PNG).expect(400);

      const pagado = await pedido(e, { paymentStatus: PaymentStatus.PAID });
      await subirComprobante(e, pagado.orderId, e.cliente, PNG).expect(409);

      // Marcada como no recibida (failed): el comprobante sirve para corregirla.
      const noRecibida = await pedido(e, {
        paymentStatus: PaymentStatus.FAILED,
      });
      await subirComprobante(e, noRecibida.orderId, e.cliente, PNG).expect(201);

      const cancelado = await pedido(e, {
        status: OrderStatus.CANCELLED,
        cancellationReason: 'prueba',
      });
      await subirComprobante(e, cancelado.orderId, e.cliente, PNG).expect(409);
    });

    it('al confirmar la transferencia ya no se acepta otro comprobante', async () => {
      const e = await escenario();
      const p = await pedido(e);
      await subirComprobante(e, p.orderId, e.cliente, PNG).expect(201);
      await http()
        .patch(`/orders/${p.orderId}/payment/confirm-transfer`)
        .set(e.adminA)
        .send({ received: true, reason: 'Figura en el extracto del banco' })
        .expect(200);
      await subirComprobante(e, p.orderId, e.cliente, PNG).expect(409);
    });

    it('tope de comprobantes por pedido', async () => {
      const e = await escenario();
      const p = await pedido(e);
      for (let i = 0; i < 5; i++) {
        await subirComprobante(e, p.orderId, e.cliente, PNG).expect(201);
      }
      await subirComprobante(e, p.orderId, e.cliente, PNG).expect(409);
      expect(
        await ds.query('SELECT count(*)::int AS n FROM attachment'),
      ).toEqual([{ n: 5 }]);
    });

    it('el admin adjunta desde el panel con el owner `order` y se lista junto al del cliente', async () => {
      const e = await escenario();
      const p = await pedido(e);
      await subirComprobante(e, p.orderId, e.cliente, PNG).expect(201);
      await http()
        .post(`/attachments/order/${p.orderId}`)
        .set(e.adminA)
        .attach('file', PNG_REAL, {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(201);
      await http()
        .post(`/attachments/order/${p.orderId}`)
        .set(e.adminB)
        .attach('file', PNG_REAL, {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(404);
      const lista = await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.adminA)
        .expect(200);
      expect(lista.body).toHaveLength(2);
    });
  });

  describe('adjuntos: owner types que antes daban 400 y documentos', () => {
    it('driver_settlement, cash_movement y customer_account_entry ya no son 400: un id inexistente es 404', async () => {
      const e = await escenario();
      for (const tipo of [
        'driver_settlement',
        'cash_movement',
        'customer_account_entry',
        'order',
      ]) {
        await http()
          .get(`/attachments/${tipo}/${randomUUID()}`)
          .set(e.adminA)
          .expect(404);
      }
    });

    it('acepta Word, Excel y CSV válidos y los baja como descarga; rechaza los falsos', async () => {
      const e = await escenario();
      const p = await pedido(e);
      const subir = (buffer: Buffer, nombre: string, mime: string) =>
        http()
          .post(`/attachments/order/${p.orderId}`)
          .set(e.adminA)
          .attach('file', buffer, { filename: nombre, contentType: mime });
      const xlsx =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      const word = await subir(
        zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
        'informe.docx',
        DOCX,
      ).expect(201);
      await subir(
        zipDePrueba(['[Content_Types].xml', 'xl/workbook.xml']),
        'planilla.xlsx',
        xlsx,
      ).expect(201);
      await subir(Buffer.from('a;b\n1;2\n'), 'lista.csv', 'text/csv').expect(
        201,
      );

      await subir(Buffer.from('MZ-ejecutable'), 'falso.docx', DOCX).expect(415);
      await subir(
        zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
        'falso.xlsx',
        xlsx,
      ).expect(415);
      await subir(Buffer.from('<html></html>'), 'x.csv', 'text/csv').expect(
        415,
      );
      await subir(Buffer.from('x'), 'viejo.doc', 'application/msword').expect(
        415,
      );

      // Aunque pidan inline, un Word se entrega como descarga.
      const enlace = await http()
        .get(
          `/attachments/${(word.body as { attachmentId: string }).attachmentId}/download?modo=url&disposicion=inline`,
        )
        .set(e.adminA)
        .expect(200);
      const bajado = await fetch((enlace.body as { url: string }).url);
      expect(bajado.headers.get('content-disposition')).toMatch(/^attachment;/);
    });
  });

  describe('lo que ve el cliente vs. lo que ve el admin', () => {
    it('el cliente ve sólo los comprobantes de transferencia y sin quién los subió; el admin ve todo', async () => {
      const e = await escenario();
      const p = await pedido(e);
      await subirComprobante(e, p.orderId, e.cliente, PNG).expect(201);
      // Adjunto interno del admin (sin rótulo de comprobante).
      const interno = await http()
        .post(`/attachments/order/${p.orderId}`)
        .set(e.adminA)
        .field('label', 'Remito interno')
        .attach('file', PNG_REAL, {
          filename: 'r.png',
          contentType: 'image/png',
        })
        .expect(201);
      // Comprobante que el admin rotula a propósito para que lo vea el cliente.
      const rotulado = await http()
        .post(`/attachments/order/${p.orderId}`)
        .set(e.adminA)
        .field('label', 'Comprobante de transferencia')
        .attach('file', PNG_REAL, {
          filename: 'c.png',
          contentType: 'image/png',
        })
        .expect(201);

      const delAdmin = await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.adminA)
        .expect(200);
      const filasAdmin = delAdmin.body as Array<{
        attachmentId: string;
        uploadedByUserId?: string;
      }>;
      expect(filasAdmin).toHaveLength(3);
      expect(
        filasAdmin.every((f) => typeof f.uploadedByUserId === 'string'),
      ).toBe(true);

      const delCliente = await http()
        .get(`/v2/orders/${p.orderId}/transfer-receipt`)
        .set(e.cliente)
        .expect(200);
      const filasCliente = delCliente.body as Array<{
        attachmentId: string;
        label: string;
      }>;
      expect(filasCliente).toHaveLength(2);
      expect(filasCliente.map((f) => f.attachmentId)).not.toContain(
        (interno.body as { attachmentId: string }).attachmentId,
      );
      expect(filasCliente.map((f) => f.attachmentId)).toContain(
        (rotulado.body as { attachmentId: string }).attachmentId,
      );
      for (const fila of filasCliente) {
        expect(fila.label).toBe('Comprobante de transferencia');
        expect(fila).not.toHaveProperty('uploadedByUserId');
      }
    });
  });

  describe('chofer y rendiciones: aislamiento entre choferes', () => {
    async function choferConRendicion(e: E, nombre: string, numero: number) {
      const u = await usuario('delivery', nombre);
      const del = await ds.getRepository(Delivery).save({
        userId: u.user.userId,
        distributorId: e.dA.distributorId,
        validated: true,
        isEnabled: true,
      } as Partial<Delivery>);
      const rendicion = await ds.getRepository(DriverSettlement).save({
        distributorId: e.dA.distributorId,
        deliveryId: del.deliveryId,
        number: numero,
        businessDate: '2026-10-27',
        status: DriverSettlementStatus.OPEN,
        expectedCash: 0,
        driverExpenses: 0,
      } as Partial<DriverSettlement>);
      return {
        headers: {
          Authorization: `Bearer ${u.email}`,
          'X-Client-Source': 'delivery-app',
        } as Headers,
        rendicionId: rendicion.settlementId,
      };
    }

    it('el chofer B no lista, sube ni descarga en la rendición del chofer A; A sí', async () => {
      const e = await escenario();
      const a = await choferConRendicion(e, 'Chofer A', 1);
      const b = await choferConRendicion(e, 'Chofer B', 2);
      const subir = (quien: Headers, rendicion: string) =>
        http()
          .post(`/attachments/driver_settlement/${rendicion}`)
          .set(quien)
          .attach('file', PNG_REAL, {
            filename: 't.png',
            contentType: 'image/png',
          });

      const subido = await subir(a.headers, a.rendicionId).expect(201);
      const id = (subido.body as { attachmentId: string }).attachmentId;

      await http()
        .get(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(a.headers)
        .expect(200);
      await http()
        .get(`/attachments/${id}/download?modo=url`)
        .set(a.headers)
        .expect(200);

      await http()
        .get(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(b.headers)
        .expect(404);
      await subir(b.headers, a.rendicionId).expect(404);
      await http()
        .get(`/attachments/${id}/download?modo=url`)
        .set(b.headers)
        .expect(404);
      await http().delete(`/attachments/${id}`).set(b.headers).expect(404);
      expect(
        await ds.query('SELECT count(*)::int AS n FROM attachment'),
      ).toEqual([{ n: 1 }]);
    });

    it('el chofer sólo sube PDF e imágenes, aunque la rendición sea suya', async () => {
      const e = await escenario();
      const a = await choferConRendicion(e, 'Chofer A', 1);
      await http()
        .post(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(a.headers)
        .attach('file', Buffer.from('a;b\n'), {
          filename: 'x.csv',
          contentType: 'text/csv',
        })
        .expect(415);
      await http()
        .post(`/attachments/driver_settlement/${a.rendicionId}`)
        .set(a.headers)
        .attach(
          'file',
          zipDePrueba(['[Content_Types].xml', 'word/document.xml']),
          {
            filename: 'x.docx',
            contentType: DOCX,
          },
        )
        .expect(415);
    });

    it('el CSV de Excel en Windows (vnd.ms-excel, Windows-1252) lo sube el admin y queda como text/csv', async () => {
      const e = await escenario();
      const p = await pedido(e);
      const res = await http()
        .post(`/attachments/order/${p.orderId}`)
        .set(e.adminA)
        .attach(
          'file',
          Buffer.from('nombre;ciudad\nJosé;Córdoba\n', 'latin1'),
          {
            filename: 'clientes.csv',
            contentType: 'application/vnd.ms-excel',
          },
        )
        .expect(201);
      expect(res.body).toMatchObject({ mimeType: 'text/csv' });
    });
  });
});
