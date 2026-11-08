/**
 * F35 E3: el pedido cobra los envases que le faltan al cliente. Contra Postgres
 * real: el servicio de la cuenta suelto y los casos de uso por HTTP (cotización,
 * alta, edición y cancelación) y la entrega por `UpdateOrderStatusUseCase`.
 */
import { DataSource } from 'typeorm';
import {
  createTestApp,
  sembrarClienteAutenticado,
  TestEnv,
  truncateAllTables,
} from './setup/test-env';
import { conIdempotencia } from './setup/con-idempotencia';
import { entregarComoAdmin } from './setup/entrega-admin';
import { Finanzas, cuerpo } from './setup/finanzas';
import { forzarEstado } from './setup/bypass';
import { CustomerContainerService } from '../../src/customer-container/customer-container.service';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { GasCylinderPromotion } from '../../src/gascylinder/entities/gascylinder-promotion.entity';
import { CoverageZone } from '../../src/coverage-zone/entities/coverage-zone.entity';
import { CustomerContainerMovementReason } from '../../src/customer-container/entities/customer-container-movement.entity';
import {
  ConfigurableProcess,
  ModuleConfig,
} from '../../src/distributor/entities/module-config.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import {
  Order,
  PaymentMethod,
  PaymentType,
} from '../../src/order/entities/order.entity';

const MENSAJE_SIN_PRECIO =
  'La distribuidora todavía no cargó el precio del envase de 10kg: no se puede tomar el pedido';

/** Punto dentro de la zona de cobertura sembrada (recargo de zona 10 %). */
const ZONA = { lng: -58.38, lat: -34.6 };

const cuadrado = (lng: number, lat: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lng - 0.02, lat - 0.02],
      [lng + 0.02, lat - 0.02],
      [lng + 0.02, lat + 0.02],
      [lng - 0.02, lat + 0.02],
      [lng - 0.02, lat - 0.02],
    ],
  ],
});

interface RenglonCotizado {
  gasCylinderId: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  containersCharged: number;
  containerUnitPrice: number | null;
  containerSubtotal: number;
}

interface Cotizacion {
  items: RenglonCotizado[];
  subtotal: number;
  containerChargeAmount: number;
  zoneSurcharge: number;
  paymentSurcharge: number;
  paymentSurchargePercentage: number;
  total: number;
}

interface PedidoJson {
  order_id: string;
  total_amount: number;
  containerChargeAmount: number;
  order_items: Array<{
    quantity: number;
    containersCharged: number;
    containerUnitPrice: number | null;
  }>;
}

interface PedidoEnBase {
  status: string;
  total: string;
  subtotal_items: string;
  zone_surcharge_amount: string;
  container_charge_amount: string;
  payment_surcharge_amount: string;
  express_surcharge_amount: string;
}

/** Reglas de envases contra Postgres real (cuenta, índice parcial y consulta). */
describe('Cobro del envase (Postgres real)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let cuentas: CustomerContainerService;
  let f: Finanzas;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    cuentas = env.app.get(CustomerContainerService);
    f = new Finanzas(env);
  }, 240000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  async function tipoConEnvase(precio: number | null): Promise<{
    distributorId: string;
    customerId: string;
    gasCylinderId: string;
  }> {
    const { distributor, user } = await sembrarClienteAutenticado(env.app);
    const tipo = await dataSource.getRepository(GasCylinder).save({
      distributorId: distributor.distributorId,
      type: '10 kg',
      weight: 10,
      price: 1000,
      containerPrice: precio,
      stock: 10,
      isActive: true,
    } as Partial<GasCylinder>);
    await dataSource.getRepository(ModuleConfig).save({
      distributorId: distributor.distributorId,
      module: ConfigurableProcess.CONTAINER_CHARGE,
      params: { enabled: 1 },
    } as Partial<ModuleConfig>);
    return {
      distributorId: distributor.distributorId,
      customerId: user.userId,
      gasCylinderId: tipo.gasCylinderId,
    };
  }

  describe('servicio de la cuenta', () => {
    it('cobra sólo la diferencia y rechaza sin precio cuando corresponde', async () => {
      const datos = await tipoConEnvase(500);
      await dataSource.transaction((manager) =>
        cuentas.registrar(manager, {
          distributorId: datos.distributorId,
          customerUserId: datos.customerId,
          gasCylinderId: datos.gasCylinderId,
          quantity: 1,
          reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
          note: 'Saldo inicial válido para la prueba',
        }),
      );
      await expect(
        cuentas.envasesACobrar(
          dataSource.manager,
          datos.distributorId,
          datos.customerId,
          [
            {
              gasCylinderId: datos.gasCylinderId,
              quantity: 2,
              containerPrice: 500,
              type: '10 kg',
            },
          ],
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          containersCharged: 1,
          containerUnitPrice: 500,
        }),
      ]);
      const sinPrecio = await tipoConEnvase(null);
      await expect(
        cuentas.envasesACobrar(
          dataSource.manager,
          sinPrecio.distributorId,
          sinPrecio.customerId,
          [
            {
              gasCylinderId: sinPrecio.gasCylinderId,
              quantity: 1,
              containerPrice: null,
              type: '10 kg',
            },
          ],
        ),
      ).rejects.toThrow(
        'La distribuidora todavía no cargó el precio del envase de 10 kg: no se puede tomar el pedido',
      );
    });

    it('acredita una compra una sola vez aunque se reintente la entrega', async () => {
      const datos = await tipoConEnvase(500);
      const direccion = await dataSource.getRepository(UserAddress).save({
        userId: datos.customerId,
        street: 'Calle de prueba 123',
        city: 'Córdoba',
        postalCode: null,
        floor: null,
        apartment: null,
        location: null,
        placeId: null,
        formattedAddress: null,
        additionalInstructions: null,
      } as Partial<UserAddress>);
      const pedido = await dataSource.getRepository(Order).save({
        distributorId: datos.distributorId,
        customerId: datos.customerId,
        addressId: direccion.addressId,
        paymentMethod: PaymentMethod.CASH,
        paymentType: PaymentType.CASH,
        totalAmount: 0,
        subtotalItems: 0,
        items: [],
      } as Partial<Order>);
      const compra = () =>
        dataSource.transaction((manager) =>
          cuentas.registrar(manager, {
            distributorId: datos.distributorId,
            customerUserId: datos.customerId,
            gasCylinderId: datos.gasCylinderId,
            quantity: 1,
            reason: CustomerContainerMovementReason.PURCHASED,
            orderId: pedido.orderId,
          }),
        );
      await expect(compra()).resolves.toBe(1);
      await expect(compra()).resolves.toBe(1);
      const [resultado]: Array<{ owned: number; movements: number }> =
        await dataSource.query(
          `SELECT a.owned::int AS owned, count(m.movement_id)::int AS movements
             FROM customer_container_account a
             LEFT JOIN customer_container_movement m ON m.account_id = a.account_id
            WHERE a.distributor_id = $1 AND a.customer_user_id = $2
            GROUP BY a.owned`,
          [datos.distributorId, datos.customerId],
        );
      expect(resultado).toEqual({ owned: 1, movements: 1 });
    });
  });

  describe('casos de uso del pedido (HTTP + entrega)', () => {
    const http = () => conIdempotencia(env.app.getHttpServer());
    type Entorno = Awaited<ReturnType<Finanzas['distribuidora']>>;
    type Cliente = { userId: string; addressId: string };

    /**
     * Distribuidora con su admin, una garrafa de 10kg a $1000 con envase a
     * `envase` (null = sin precio) y una zona de cobertura con 10 % de recargo.
     */
    async function escenario(envase: number | null = 500): Promise<Entorno> {
      const e = await f.distribuidora();
      await dataSource.getRepository(ModuleConfig).save({
        distributorId: e.distributorId,
        module: ConfigurableProcess.CONTAINER_CHARGE,
        params: { enabled: 1 },
      } as Partial<ModuleConfig>);
      await dataSource
        .getRepository(GasCylinder)
        .update(
          { gasCylinderId: e.garrafa.gasCylinderId },
          { containerPrice: envase },
        );
      await dataSource.getRepository(CoverageZone).save({
        distributorId: e.distributorId,
        name: 'Centro',
        area: cuadrado(ZONA.lng, ZONA.lat),
        surchargeType: 'percentage',
        surchargeValue: 10,
      } as unknown as Partial<CoverageZone>);
      return e;
    }

    /** Cliente con una dirección dentro de la zona y `owned` envases propios. */
    async function cliente(e: Entorno, owned = 0): Promise<Cliente> {
      const c = await f.cliente();
      const dir = await dataSource.getRepository(UserAddress).save({
        userId: c.userId,
        street: 'Calle en zona 1',
        city: 'CABA',
        location: { type: 'Point', coordinates: [ZONA.lng, ZONA.lat] },
      } as unknown as Partial<UserAddress>);
      if (owned > 0) {
        await dataSource.transaction((manager) =>
          cuentas.registrar(manager, {
            distributorId: e.distributorId,
            customerUserId: c.userId,
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: owned,
            reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
            note: 'Saldo inicial de la prueba',
          }),
        );
      }
      return { userId: c.userId, addressId: dir.addressId };
    }

    const cuerpoDelPedido = (
      e: Entorno,
      c: Cliente,
      cantidad: number,
      extra: Record<string, unknown> = {},
    ) => ({
      customerId: c.userId,
      addressId: c.addressId,
      paymentMethod: 'cash',
      items: [
        {
          gasCylinderId: e.garrafa.gasCylinderId,
          quantity: cantidad,
          unitPrice: 1000,
        },
      ],
      ...extra,
    });

    /** Renglones de `PATCH /orders/:id` (sin `unitPrice`: el DTO de edición no lo acepta). */
    const itemsDeEdicion = (e: Entorno, cantidad: number) => [
      { gasCylinderId: e.garrafa.gasCylinderId, quantity: cantidad },
    ];
    /** Los mismos renglones para `POST /orders/quote`, que sí exige `unitPrice`. */
    const itemsDeCotizacion = (e: Entorno, cantidad: number) =>
      itemsDeEdicion(e, cantidad).map((i) => ({ ...i, unitPrice: 1000 }));

    const cotizar = (e: Entorno, body: Record<string, unknown>) =>
      http().post('/orders/quote').set(e.headers).send(body);

    const crear = (e: Entorno, body: Record<string, unknown>) =>
      http().post('/orders').set(e.headers).send(body);

    async function crearOk(
      e: Entorno,
      body: Record<string, unknown>,
    ): Promise<PedidoJson> {
      const res = await crear(e, body);
      expect({ status: res.status, body: res.body as unknown }).toMatchObject({
        status: 201,
      });
      return cuerpo<PedidoJson>(res);
    }

    async function pedidoEnBase(orderId: string): Promise<PedidoEnBase> {
      const [fila] = await dataSource.query<PedidoEnBase[]>(
        `SELECT status, "totalAmount"::text AS total, subtotal_items::text,
                zone_surcharge_amount::text, container_charge_amount::text,
                payment_surcharge_amount::text, express_surcharge_amount::text
           FROM "order" WHERE order_id = $1`,
        [orderId],
      );
      return fila;
    }

    async function renglonesEnBase(orderId: string) {
      return dataSource.query<
        Array<{
          quantity: number;
          containers_charged: number;
          container_unit_price: string | null;
        }>
      >(
        `SELECT quantity, containers_charged, container_unit_price::text
           FROM order_item WHERE order_id = $1`,
        [orderId],
      );
    }

    async function cuentaDe(e: Entorno, c: Cliente) {
      const [fila] = await dataSource.query<
        Array<{ owned: number; compras: number }>
      >(
        `SELECT a.owned::int AS owned,
                (SELECT count(*)::int FROM customer_container_movement m
                  WHERE m.account_id = a.account_id AND m.reason = 'purchased') AS compras
           FROM customer_container_account a
          WHERE a.distributor_id = $1 AND a.customer_user_id = $2 AND a.gas_cylinder_id = $3`,
        [e.distributorId, c.userId, e.garrafa.gasCylinderId],
      );
      return fila ?? { owned: 0, compras: 0 };
    }

    async function ponerEnCamino(e: Entorno, orderId: string) {
      const chofer = await f.chofer(e.distributorId);
      await forzarEstado(
        dataSource,
        `UPDATE "order" SET status = 'on_the_way', delivery_id = $2, "acceptedAt" = now(), "onTheWayAt" = now()
          WHERE order_id = $1`,
        [orderId, chofer.deliveryId],
      );
    }

    it('1. alta con expectedTotal que cobra 1 envase: persiste el cargo y el total cierra con la fórmula', async () => {
      const e = await escenario(500);
      const c = await cliente(e, 1);
      const body = cuerpoDelPedido(e, c, 2, { paymentMethod: 'transfer' });

      const q = cuerpo<Cotizacion>(await cotizar(e, body).expect(200));
      // subtotal 2000, zona 10 % = 200 (sólo sobre la recarga), envase 1 × 500,
      // recargo de transferencia 10 % sobre (2000 + 200 + 500) = 270.
      expect(q).toMatchObject({
        subtotal: 2000,
        zoneSurcharge: 200,
        containerChargeAmount: 500,
        paymentSurcharge: 270,
        total: 2970,
      });
      expect(q.items[0]).toMatchObject({
        containersCharged: 1,
        containerUnitPrice: 500,
        containerSubtotal: 500,
      });

      const p = await crearOk(e, { ...body, expectedTotal: q.total });
      expect(p.total_amount).toBe(2970);
      expect(p.containerChargeAmount).toBe(500);
      expect(p.order_items[0]).toMatchObject({
        quantity: 2,
        containersCharged: 1,
        containerUnitPrice: 500,
      });

      const enBase = await pedidoEnBase(p.order_id);
      expect(enBase).toMatchObject({
        total: '2970.00',
        subtotal_items: '2000.00',
        zone_surcharge_amount: '200.00',
        container_charge_amount: '500.00',
        payment_surcharge_amount: '270.00',
      });
      expect(await renglonesEnBase(p.order_id)).toEqual([
        { quantity: 2, containers_charged: 1, container_unit_price: '500.00' },
      ]);
      // Crear un pedido no toca la cuenta: se acredita al entregar.
      expect(await cuentaDe(e, c)).toEqual({ owned: 1, compras: 0 });

      // Un expectedTotal que no incluye los envases se rechaza (409 PRICE_CHANGED).
      const viejo = await crear(e, { ...body, expectedTotal: 2420 });
      expect(viejo.status).toBe(409);
    });

    it('2. la entrega suma los envases cobrados una sola vez, aunque se reintente', async () => {
      const e = await escenario(500);
      const c = await cliente(e, 1);
      const p = await crearOk(e, cuerpoDelPedido(e, c, 3));
      expect(p.containerChargeAmount).toBe(1000);
      await ponerEnCamino(e, p.order_id);

      await entregarComoAdmin(env, p.order_id);
      expect((await pedidoEnBase(p.order_id)).status).toBe('delivered');
      expect(await cuentaDe(e, c)).toEqual({ owned: 3, compras: 1 });
      const [mov] = await dataSource.query<
        Array<{ quantity: number; order_id: string }>
      >(
        `SELECT quantity, order_id FROM customer_container_movement WHERE reason = 'purchased'`,
      );
      expect(mov).toEqual({ quantity: 2, order_id: p.order_id });

      // Segundo intento de entrega: lo rechace la máquina de estados o no,
      // no puede crear otro movimiento ni sumar.
      await entregarComoAdmin(env, p.order_id).catch(() => undefined);
      expect(await cuentaDe(e, c)).toEqual({ owned: 3, compras: 1 });
    });

    it('3. cancelar otro pedido con envases cobrados no cambia la cuenta', async () => {
      const e = await escenario(500);
      const c = await cliente(e, 1);
      const pendiente = await crearOk(e, cuerpoDelPedido(e, c, 2));
      expect(pendiente.containerChargeAmount).toBe(500);
      await http()
        .patch(`/orders/${pendiente.order_id}/cancel`)
        .set(e.headers)
        .send({ reason: 'El cliente se arrepintió' })
        .expect(200);

      const enCamino = await crearOk(e, cuerpoDelPedido(e, c, 2));
      expect(enCamino.containerChargeAmount).toBe(500);
      await ponerEnCamino(e, enCamino.order_id);
      await http()
        .patch(`/orders/${enCamino.order_id}/cancel`)
        .set(e.headers)
        .send({ reason: 'No estaba en el domicilio' })
        .expect(200);

      expect((await pedidoEnBase(pendiente.order_id)).status).toBe('cancelled');
      expect((await pedidoEnBase(enCamino.order_id)).status).toBe('cancelled');
      expect(await cuentaDe(e, c)).toEqual({ owned: 1, compras: 0 });
    });

    it('4. un pedido abierto compromete envases del mismo cliente; el de otro cliente no', async () => {
      const e = await escenario(500);
      const c = await cliente(e, 1);
      const otro = await cliente(e, 1);

      // El otro cliente usa su envase propio en un pedido abierto.
      const ajeno = await crearOk(e, cuerpoDelPedido(e, otro, 1));
      expect(ajeno.containerChargeAmount).toBe(0);

      // Al cliente no le afecta: su envase sigue disponible.
      const primero = await crearOk(e, cuerpoDelPedido(e, c, 1));
      expect(primero.containerChargeAmount).toBe(0);
      expect(primero.order_items[0].containersCharged).toBe(0);

      // El segundo pedido del mismo tipo ya no tiene envase propio: cobra 2 de 2.
      const q = cuerpo<Cotizacion>(
        await cotizar(e, cuerpoDelPedido(e, c, 2)).expect(200),
      );
      expect(q.containerChargeAmount).toBe(1000);
      const segundo = await crearOk(e, {
        ...cuerpoDelPedido(e, c, 2),
        expectedTotal: q.total,
      });
      expect(segundo.containerChargeAmount).toBe(1000);
      expect(segundo.order_items[0].containersCharged).toBe(2);

      // Con owned = 3 y el primero comprometiendo 1, cobra sólo la diferencia.
      const tercero = await cliente(e, 3);
      await crearOk(e, cuerpoDelPedido(e, tercero, 1));
      const diferencia = await crearOk(e, cuerpoDelPedido(e, tercero, 3));
      expect(diferencia.order_items[0].containersCharged).toBe(1);
      expect(diferencia.containerChargeAmount).toBe(500);
    });

    it('5. tipo sin precio de envase: 400 con el mensaje exacto si hay que cobrar; entra si no', async () => {
      const e = await escenario(null);
      const sinEnvases = await cliente(e, 0);
      const cotizado = await cotizar(e, cuerpoDelPedido(e, sinEnvases, 1));
      expect(cotizado.status).toBe(400);
      expect((cotizado.body as { message: string }).message).toBe(
        MENSAJE_SIN_PRECIO,
      );
      const rechazado = await crear(e, cuerpoDelPedido(e, sinEnvases, 1));
      expect(rechazado.status).toBe(400);
      expect((rechazado.body as { message: string }).message).toBe(
        MENSAJE_SIN_PRECIO,
      );
      const [{ n }] = await dataSource.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "order"`,
      );
      expect(n).toBe(0);

      const conEnvase = await cliente(e, 1);
      const p = await crearOk(e, cuerpoDelPedido(e, conEnvase, 1));
      expect(p.containerChargeAmount).toBe(0);
      expect(p.order_items[0]).toMatchObject({
        containersCharged: 0,
        containerUnitPrice: null,
      });
      expect(await renglonesEnBase(p.order_id)).toEqual([
        { quantity: 1, containers_charged: 0, container_unit_price: null },
      ]);
    });

    it('6. promo por volumen + recargo de pago: el envase va sin descuento y con recargo', async () => {
      const e = await escenario(500);
      await dataSource.getRepository(GasCylinderPromotion).save({
        gasCylinderId: e.garrafa.gasCylinderId,
        quantity: 2,
        discountPercentage: 10,
      } as Partial<GasCylinderPromotion>);
      const c = await cliente(e, 0);
      const body = cuerpoDelPedido(e, c, 2, { paymentMethod: 'transfer' });

      // Recarga 2 × 900 = 1800; zona 10 % de 1800 = 180; envases 2 × 500 = 1000
      // (sin el 10 % de la promo); transferencia 10 % de (1800 + 180 + 1000) = 298.
      const q = cuerpo<Cotizacion>(await cotizar(e, body).expect(200));
      expect(q).toMatchObject({
        subtotal: 1800,
        zoneSurcharge: 180,
        containerChargeAmount: 1000,
        paymentSurcharge: 298,
        total: 3278,
      });
      expect(q.items[0]).toMatchObject({
        unitPrice: 900,
        containersCharged: 2,
        containerUnitPrice: 500,
        containerSubtotal: 1000,
      });
      const p = await crearOk(e, { ...body, expectedTotal: q.total });
      expect(await pedidoEnBase(p.order_id)).toMatchObject({
        total: '3278.00',
        subtotal_items: '1800.00',
        zone_surcharge_amount: '180.00',
        container_charge_amount: '1000.00',
        payment_surcharge_amount: '298.00',
      });
    });

    describe('7. PATCH del pedido', () => {
      it('cambiando los ítems recalcula los envases (sin contarse a sí mismo como comprometido)', async () => {
        const e = await escenario(500);
        const c = await cliente(e, 1);
        const p = await crearOk(e, cuerpoDelPedido(e, c, 1));
        expect(p.containerChargeAmount).toBe(0);

        const nuevo = { items: itemsDeEdicion(e, 3) };
        const q = cuerpo<Cotizacion>(
          await cotizar(e, {
            items: itemsDeCotizacion(e, 3),
            orderId: p.order_id,
            paymentMethod: 'cash',
          }).expect(200),
        );
        expect(q.containerChargeAmount).toBe(1000);
        const editado = cuerpo<PedidoJson>(
          await http()
            .patch(`/orders/${p.order_id}`)
            .set(e.headers)
            .send(nuevo)
            .expect(200),
        );
        expect(editado.containerChargeAmount).toBe(1000);
        expect(editado.order_items[0].containersCharged).toBe(2);
        expect(editado.total_amount).toBe(q.total);
        expect(await pedidoEnBase(p.order_id)).toMatchObject({
          container_charge_amount: '1000.00',
          total: q.total.toFixed(2),
        });

        // Bajar a 1 unidad: vuelve a alcanzar el envase propio.
        const abajo = cuerpo<PedidoJson>(
          await http()
            .patch(`/orders/${p.order_id}`)
            .set(e.headers)
            .send({ items: itemsDeEdicion(e, 1) })
            .expect(200),
        );
        expect(abajo.containerChargeAmount).toBe(0);
        // El precio unitario del envase queda como foto del catálogo aunque no se cobre.
        expect(await renglonesEnBase(p.order_id)).toEqual([
          expect.objectContaining({ quantity: 1, containers_charged: 0 }),
        ]);
        expect(await pedidoEnBase(p.order_id)).toMatchObject({
          container_charge_amount: '0.00',
          total: '1100.00',
        });
      });

      it('cambiando sólo el medio de pago (sin ítems) el total es el de la cotización de edición', async () => {
        const e = await escenario(500);
        const c = await cliente(e, 1);
        const p = await crearOk(e, cuerpoDelPedido(e, c, 2));
        expect(p.containerChargeAmount).toBe(500);
        const q = cuerpo<Cotizacion>(
          await cotizar(e, {
            orderId: p.order_id,
            paymentMethod: 'transfer',
            items: itemsDeCotizacion(e, 2),
          }).expect(200),
        );
        // 2000 + 200 + 500 = 2700; transferencia 10 % = 270.
        expect(q).toMatchObject({ containerChargeAmount: 500, total: 2970 });
        const editado = cuerpo<PedidoJson>(
          await http()
            .patch(`/orders/${p.order_id}`)
            .set(e.headers)
            .send({ paymentMethod: 'transfer' })
            .expect(200),
        );
        expect(editado.total_amount).toBe(q.total);
        expect(editado.containerChargeAmount).toBe(500);
        expect(await pedidoEnBase(p.order_id)).toMatchObject({
          total: '2970.00',
          container_charge_amount: '500.00',
          payment_surcharge_amount: '270.00',
        });
      });

      it('cambiando el medio de pago con los mismos ítems el total es el de la cotización de edición', async () => {
        const e = await escenario(500);
        const c = await cliente(e, 1);
        const p = await crearOk(e, cuerpoDelPedido(e, c, 2));
        const body = {
          paymentMethod: 'transfer',
          items: itemsDeEdicion(e, 2),
        };
        const q = cuerpo<Cotizacion>(
          await cotizar(e, {
            ...body,
            items: itemsDeCotizacion(e, 2),
            orderId: p.order_id,
          }).expect(200),
        );
        expect(q.total).toBe(2970);
        const editado = cuerpo<PedidoJson>(
          await http()
            .patch(`/orders/${p.order_id}`)
            .set(e.headers)
            .send(body)
            .expect(200),
        );
        expect(editado.total_amount).toBe(q.total);
        expect(editado.containerChargeAmount).toBe(500);
      });

      /** Pedido de 2 que cobró 1 envase; después la cuenta suma otro (owned = 2). */
      async function pedidoConCuentaCambiada() {
        const e = await escenario(500);
        const c = await cliente(e, 1);
        const p = await crearOk(e, cuerpoDelPedido(e, c, 2));
        expect(p.containerChargeAmount).toBe(500);
        await dataSource.transaction((manager) =>
          cuentas.registrar(manager, {
            distributorId: e.distributorId,
            customerUserId: c.userId,
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: 1,
            reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
            note: 'Ajuste posterior al alta',
          }),
        );
        const q = cuerpo<Cotizacion>(
          await cotizar(e, {
            orderId: p.order_id,
            paymentMethod: 'transfer',
            items: itemsDeCotizacion(e, 2),
          }).expect(200),
        );
        return { e, c, p, q };
      }

      // Regla única: si los renglones no cambian (no vienen, o vienen los mismos), el pedido
      // conserva sus precios y envases guardados, y la cotización de edición devuelve lo mismo.
      it('cuenta cambiada después del alta: PATCH sólo de pago = cotización de edición (conserva los envases)', async () => {
        const { e, p, q } = await pedidoConCuentaCambiada();
        const editado = cuerpo<PedidoJson>(
          await http()
            .patch(`/orders/${p.order_id}`)
            .set(e.headers)
            .send({ paymentMethod: 'transfer' })
            .expect(200),
        );
        expect({
          total: editado.total_amount,
          envases: editado.containerChargeAmount,
        }).toEqual({ total: q.total, envases: q.containerChargeAmount });
        expect(editado.containerChargeAmount).toBe(p.containerChargeAmount);
      });

      it('cuenta cambiada después del alta: PATCH de pago con los mismos ítems = cotización de edición', async () => {
        const { e, p, q } = await pedidoConCuentaCambiada();
        const editado = cuerpo<PedidoJson>(
          await http()
            .patch(`/orders/${p.order_id}`)
            .set(e.headers)
            .send({ paymentMethod: 'transfer', items: itemsDeEdicion(e, 2) })
            .expect(200),
        );
        expect({
          total: editado.total_amount,
          envases: editado.containerChargeAmount,
        }).toEqual({ total: q.total, envases: q.containerChargeAmount });
      });

      it('cuenta cambiada después del alta: PATCH de notas con los mismos ítems deja renglones y cargo del pedido coherentes', async () => {
        const { e, p } = await pedidoConCuentaCambiada();
        await http()
          .patch(`/orders/${p.order_id}`)
          .set(e.headers)
          .send({ notes: 'Tocar timbre', items: itemsDeEdicion(e, 2) })
          .expect(200);
        const [renglon] = await renglonesEnBase(p.order_id);
        const pedido = await pedidoEnBase(p.order_id);
        // Lo que se acredita al entregar (renglón) tiene que ser lo cobrado (pedido).
        expect({
          renglon: renglon.containers_charged * 500,
          pedido: Number(pedido.container_charge_amount),
        }).toEqual({
          renglon: Number(pedido.container_charge_amount),
          pedido: Number(pedido.container_charge_amount),
        });
      });
    });

    it('8. dos altas concurrentes con owned = 1 cobran entre las dos exactamente 1 envase', async () => {
      const e = await escenario(500);
      const c = await cliente(e, 1);
      const respuestas = await Promise.all([
        crear(e, cuerpoDelPedido(e, c, 1)),
        crear(e, cuerpoDelPedido(e, c, 1)),
      ]);
      expect(respuestas.map((r) => r.status)).toEqual([201, 201]);
      const [{ cobrados, importe }] = await dataSource.query<
        Array<{ cobrados: number; importe: string }>
      >(
        `SELECT COALESCE(SUM(oi.containers_charged), 0)::int AS cobrados,
                (SELECT COALESCE(SUM(container_charge_amount), 0)::text FROM "order") AS importe
           FROM order_item oi`,
      );
      expect(cobrados).toBe(1);
      expect(importe).toBe('500.00');
    });
  });
});
