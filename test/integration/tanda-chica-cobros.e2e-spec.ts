/**
 * Tests de integración (Postgres real): cobros y lecturas de pedidos.
 *
 * - `register-unpaid` deja el motivo en el pedido.
 * - `GET /orders/:id/status-history`: aislamiento por tenant y por dueño.
 * - `pendingRefund` ubica el reintegro por el día de la cancelación y no por
 *   `updatedAt`.
 * - El pedido en curso del chofer no depende de qué tan nuevo sea.
 */
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../src/order/entities/order.entity';
import { OrderStatusHistory } from '../../src/order/entities/order-status-history.entity';
import { User } from '../../src/users/entities/user.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { UnpaidCashService } from '../../src/incident/unpaid-cash.service';
import { ReportsService } from '../../src/reports/reports.service';
import { OrderService } from '../../src/order/order.service';
import { AdminGateway } from '../../src/gateways/admin.gateway';
import { fechasSegunEstado } from './setup/pedido-valido';

describe('Cobros y lecturas de pedidos (e2e, Postgres real)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let unpaid: UnpaidCashService;
  let reports: ReportsService;
  let orders: OrderService;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    unpaid = env.app.get(UnpaidCashService);
    reports = env.app.get(ReportsService);
    orders = env.app.get(OrderService);
    jest
      .spyOn(env.app.get(AdminGateway), 'notifyAdmins')
      .mockImplementation(() => undefined);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  /** Una distribuidora con su chofer, su cliente y su dirección. */
  async function escenario() {
    seq += 1;
    const sufijo = `${seq}-${Date.now()}`;
    const distributor = (await dataSource.getRepository(Distributor).save({
      name: `Distribuidora Tanda ${sufijo}`,
      slug: `dist-tanda-${sufijo}`,
      legalName: 'Test SRL',
      taxId: `30-${seq}${Date.now()}`,
      email: `dist-tanda${sufijo}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>)) as Distributor;
    const chofer = (await dataSource.getRepository(User).save({
      email: `chofer-tanda-${sufijo}@splg.local`,
      fullName: 'Chofer Tanda',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    const delivery = (await dataSource.getRepository(Delivery).save({
      userId: chofer.userId,
      distributorId: distributor.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;
    const cliente = (await dataSource.getRepository(User).save({
      email: `cliente-tanda-${sufijo}@splg.local`,
      fullName: 'Cliente Tanda',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    await dataSource.getRepository(Customer).save({
      userId: cliente.userId,
      notificationToken: 'fake-fcm',
    } as Partial<Customer>);
    const address = (await dataSource.getRepository(UserAddress).save({
      userId: cliente.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;

    const pedido = async (parcial: Partial<Order>): Promise<Order> =>
      (await dataSource.getRepository(Order).save({
        customerId: cliente.userId,
        distributorId: distributor.distributorId,
        addressId: address.addressId,
        status: OrderStatus.DELIVERED,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PENDING,
        totalAmount: 1000,
        subtotalItems: 1000,
        deliveryId: delivery.deliveryId,
        ...fechasSegunEstado(parcial.status ?? OrderStatus.DELIVERED),
        ...parcial,
      } as Partial<Order>)) as Order;

    return { distributor, chofer, delivery, cliente, pedido };
  }

  it('register-unpaid deja el motivo, quién y cuándo en el pedido', async () => {
    const { distributor, pedido } = await escenario();
    const admin = (await dataSource.getRepository(User).save({
      email: `admin-tanda-${Date.now()}@splg.local`,
      fullName: 'Admin',
      phoneNumber: telefonoDePrueba(),
    } as Partial<User>)) as User;
    const order = await pedido({ deliveredAt: new Date() });

    await unpaid.reportByAdmin(
      order.orderId,
      'El chofer no pudo informarlo',
      admin.userId,
      distributor.distributorId,
    );

    const guardado = await dataSource
      .getRepository(Order)
      .findOneByOrFail({ orderId: order.orderId });
    expect(guardado.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(guardado.paymentResolutionNote).toBe('El chofer no pudo informarlo');
    expect(guardado.paymentResolvedBy).toBe(admin.userId);
    expect(guardado.paymentResolvedAt).toBeInstanceOf(Date);
  });

  describe('historial de estados', () => {
    it('lo lee quien lee el pedido; otro cliente u otra distribuidora, 404', async () => {
      const { distributor, cliente, pedido } = await escenario();
      const otra = await escenario();
      const order = await pedido({});
      // El alta ya dejó su fila (la asienta el subscriber): se parte de cero.
      await dataSource.query(
        `DELETE FROM order_status_history WHERE order_id = $1`,
        [order.orderId],
      );
      await dataSource.getRepository(OrderStatusHistory).insert([
        {
          orderId: order.orderId,
          fromStatus: null,
          toStatus: OrderStatus.PENDING,
          changedByUserId: cliente.userId,
          changedAt: new Date('2026-10-01T10:00:00Z'),
        },
        {
          orderId: order.orderId,
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.ON_THE_WAY,
          changedByUserId: null,
          changedAt: new Date('2026-10-01T11:00:00Z'),
        },
        {
          orderId: order.orderId,
          fromStatus: OrderStatus.ON_THE_WAY,
          toStatus: OrderStatus.ON_THE_WAY,
          reason: 'nota',
          changedByUserId: null,
          changedAt: new Date('2026-10-01T12:00:00Z'),
        },
      ]);

      const delAdmin = await orders.getStatusHistory(
        order.orderId,
        distributor.distributorId,
        undefined,
        undefined,
        true,
      );
      expect(delAdmin.map((h) => [h.fromStatus, h.toStatus, h.isNote])).toEqual(
        [
          [null, 'pending', false],
          ['pending', 'out_for_delivery', false],
          ['out_for_delivery', 'out_for_delivery', true],
        ],
      );
      expect(delAdmin[0].changedBy?.fullName).toBe('Cliente Tanda');
      expect(delAdmin[1].changedBy).toBeNull();

      const delCliente = await orders.getStatusHistory(
        order.orderId,
        distributor.distributorId,
        cliente.userId,
      );
      expect(delCliente[0].changedBy?.fullName).toBeNull();

      await expect(
        orders.getStatusHistory(
          order.orderId,
          distributor.distributorId,
          otra.cliente.userId,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        orders.getStatusHistory(order.orderId, otra.distributor.distributorId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GET /reports/collections · pendingRefund', () => {
    const DIA = {
      desde: '2026-03-10T03:00:00Z',
      hasta: '2026-03-11T03:00:00Z',
    };

    async function cancelado(
      pedido: (p: Partial<Order>) => Promise<Order>,
      canceladoEn: string | null,
      actualizadoEn: string,
    ) {
      const order = await pedido({
        status: OrderStatus.CANCELLED,
        paymentMethod: PaymentMethod.TRANSFER,
        paymentStatus: PaymentStatus.PAID,
      });
      // El alta ya dejó su fila (la asienta el subscriber): se parte de cero.
      await dataSource.query(
        `DELETE FROM order_status_history WHERE order_id = $1`,
        [order.orderId],
      );
      if (canceladoEn) {
        await dataSource.query(
          `INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1, 'pending', 'cancelled', $2)`,
          [order.orderId, canceladoEn],
        );
      }
      await dataSource.query(
        `UPDATE "order" SET "updatedAt" = $2 WHERE order_id = $1`,
        [order.orderId, actualizadoEn],
      );
      return order;
    }

    const refund = async (distributorId: string) =>
      (
        await reports.getCollections(
          new Date(DIA.desde),
          new Date(DIA.hasta),
          distributorId,
        )
      ).pendingRefund;

    it('cuenta por el día de la cancelación aunque una edición posterior mueva updatedAt', async () => {
      const { distributor, pedido } = await escenario();
      await cancelado(pedido, '2026-03-10T15:00:00Z', '2026-05-01T12:00:00Z');
      expect(await refund(distributor.distributorId)).toEqual({
        totalOrders: 1,
        totalAmount: 1000,
      });
    });

    it('no cuenta uno cancelado otro día aunque updatedAt caiga en el rango', async () => {
      const { distributor, pedido } = await escenario();
      await cancelado(pedido, '2026-02-01T15:00:00Z', '2026-03-10T15:00:00Z');
      expect(await refund(distributor.distributorId)).toEqual({
        totalOrders: 0,
        totalAmount: 0,
      });
    });

    it('un cancelado anterior al historial cae a updatedAt', async () => {
      const { distributor, pedido } = await escenario();
      await cancelado(pedido, null, '2026-03-10T15:00:00Z');
      expect(await refund(distributor.distributorId)).toEqual({
        totalOrders: 1,
        totalAmount: 1000,
      });
    });
  });

  describe('pedido en curso del chofer', () => {
    it('devuelve el aceptado aunque sea viejo y haya muchos pedidos más nuevos', async () => {
      const { distributor, chofer, pedido } = await escenario();
      const viejo = await pedido({
        status: OrderStatus.ACCEPTED,
        paymentStatus: PaymentStatus.PENDING,
        acceptedAt: new Date('2026-01-01T10:00:00Z'),
        createdAt: new Date('2026-01-01T09:00:00Z'),
      });
      for (let i = 0; i < 25; i += 1) {
        await pedido({
          status: OrderStatus.DELIVERED,
          paymentStatus: PaymentStatus.PAID,
          deliveredAt: new Date('2026-02-01T10:00:00Z'),
        });
      }
      const actual = await orders.findCurrentOfDriver(
        chofer.userId,
        distributor.distributorId,
      );
      expect(actual?.id).toBe(viejo.orderId);
    });

    it('prefiere el que está en camino', async () => {
      const { distributor, chofer, pedido } = await escenario();
      await pedido({
        status: OrderStatus.ACCEPTED,
        acceptedAt: new Date('2026-01-01T10:00:00Z'),
      });
      const enCamino = await pedido({
        status: OrderStatus.ON_THE_WAY,
        acceptedAt: new Date('2026-01-02T10:00:00Z'),
      });
      const actual = await orders.findCurrentOfDriver(
        chofer.userId,
        distributor.distributorId,
      );
      expect(actual?.id).toBe(enCamino.orderId);
    });

    it('sin activos, el entregado hoy en efectivo con cobro pendiente; no el de ayer ni el cobrado', async () => {
      const { distributor, chofer, pedido } = await escenario();
      await pedido({
        paymentStatus: PaymentStatus.PENDING,
        deliveredAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      });
      await pedido({
        paymentStatus: PaymentStatus.PAID,
        deliveredAt: new Date(),
      });
      expect(
        await orders.findCurrentOfDriver(
          chofer.userId,
          distributor.distributorId,
        ),
      ).toBeNull();
      const hoy = await pedido({
        paymentStatus: PaymentStatus.PENDING,
        deliveredAt: new Date(),
      });
      const actual = await orders.findCurrentOfDriver(
        chofer.userId,
        distributor.distributorId,
      );
      expect(actual?.id).toBe(hoy.orderId);
    });

    it('no devuelve pedidos de otra distribuidora ni de otro chofer', async () => {
      const a = await escenario();
      const b = await escenario();
      await a.pedido({ status: OrderStatus.ACCEPTED });
      expect(
        await orders.findCurrentOfDriver(
          b.chofer.userId,
          b.distributor.distributorId,
        ),
      ).toBeNull();
      expect(
        await orders.findCurrentOfDriver(
          a.chofer.userId,
          b.distributor.distributorId,
        ),
      ).toBeNull();
    });
  });
});
