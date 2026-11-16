/**
 * Tests de integración: la migración que pasa las fechas del pedido y de los
 * reclamos a `timestamptz` no corre los datos, y la numeración de comprobantes
 * es correlativa y segura bajo concurrencia.
 */
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  sembrarClienteAutenticado,
  truncateAllTables,
} from './setup/test-env';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { Claim } from '../../src/claims/entities/claim.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { CrearDocumentSequence1791000100000 } from '../../src/migrations/1791000100000-CrearDocumentSequence';
import { OrderTimestampsConZona1791000000000 } from '../../src/migrations/1791000000000-OrderTimestampsConZona';
import {
  DocType,
  DocumentSequenceService,
} from '../../src/document-sequence/document-sequence.service';
import { fechasDeEntrega, sembrarChoferDeFixture } from './setup/pedido-valido';

describe('Fechas con zona y numeración de comprobantes (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;
  let distributorId: string;
  let customerId: string;
  let addressId: string;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    const { user, distributor } = await sembrarClienteAutenticado(env.app);
    distributorId = distributor.distributorId;
    customerId = user.userId;
    const address = (await dataSource.getRepository(UserAddress).save({
      userId: user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;
    addressId = address.addressId;
  });

  describe('OrderTimestampsConZona', () => {
    it('convierte la hora argentina sin zona al mismo instante (23:30 ART)', async () => {
      const migracion = new OrderTimestampsConZona1791000000000();
      const qr = dataSource.createQueryRunner();
      try {
        const pedido = (await dataSource.getRepository(Order).save({
          distributorId,
          customerId,
          addressId,
          status: OrderStatus.DELIVERED,
          paymentMethod: PaymentMethod.CASH,
          subtotalItems: 1000,
          totalAmount: 1000,
          deliveryId: (await sembrarChoferDeFixture(dataSource, distributorId))
            .deliveryId,
          ...fechasDeEntrega(),
        } as Partial<Order>)) as Order;
        const reclamo = (await dataSource.getRepository(Claim).save({
          distributorId,
          orderId: pedido.orderId,
          customerId,
          reason: 'Fuga',
          description: 'Huele a gas',
        } as Partial<Claim>)) as Claim;

        // Estado previo a la migración: columnas sin zona con hora argentina.
        await migracion.down(qr);
        await qr.query(
          `UPDATE "order" SET "createdAt" = '2026-07-06 21:00:00-03', "updatedAt" = '2026-07-07 00:00:00-03', "acceptedAt" = '2026-07-06 22:00:00', "onTheWayAt" = '2026-07-06 22:30:00', "deliveredAt" = '2026-07-06 23:30:00' WHERE "order_id" = $1`,
          [pedido.orderId],
        );
        await qr.query(
          `UPDATE "claims" SET "createdAt" = '2026-07-06 23:45:00' WHERE "claim_id" = $1`,
          [reclamo.claimId],
        );

        await migracion.up(qr);

        const [o] = (await qr.query(
          `SELECT to_char("acceptedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') a, to_char("onTheWayAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') c, to_char("deliveredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') d FROM "order" WHERE "order_id" = $1`,
          [pedido.orderId],
        )) as { a: string; c: string; d: string }[];
        expect(o).toEqual({
          a: '2026-07-07T01:00:00Z',
          c: '2026-07-07T01:30:00Z',
          d: '2026-07-07T02:30:00Z',
        });
        const recargado = await dataSource
          .getRepository(Order)
          .findOneByOrFail({ orderId: pedido.orderId });
        expect(recargado.deliveredAt?.toISOString()).toBe(
          '2026-07-07T02:30:00.000Z',
        );
        const recl = await dataSource
          .getRepository(Claim)
          .findOneByOrFail({ claimId: reclamo.claimId });
        expect(recl.createdAt.toISOString()).toBe('2026-07-07T02:45:00.000Z');

        // El down devuelve la hora argentina original.
        await migracion.down(qr);
        const [naive] = (await qr.query(
          `SELECT "deliveredAt"::text d FROM "order" WHERE "order_id" = $1`,
          [pedido.orderId],
        )) as { d: string }[];
        expect(naive.d).toBe('2026-07-06 23:30:00');
        await migracion.up(qr);
      } finally {
        await qr.release();
      }
    });
  });

  describe('OrderTimestampsConZona: verificación previa', () => {
    it('aborta, sin tocar nada, si hay datos que no encajan con hora argentina', async () => {
      const migracion = new OrderTimestampsConZona1791000000000();
      const qr = dataSource.createQueryRunner();
      try {
        const pedido = (await dataSource.getRepository(Order).save({
          distributorId,
          customerId,
          addressId,
          status: OrderStatus.DELIVERED,
          paymentMethod: PaymentMethod.CASH,
          subtotalItems: 1000,
          totalAmount: 1000,
          deliveryId: (await sembrarChoferDeFixture(dataSource, distributorId))
            .deliveryId,
          ...fechasDeEntrega(),
        } as Partial<Order>)) as Order;
        await migracion.down(qr);
        // Escrito en UTC: leído como hora argentina quedaría 3 h en el futuro
        // respecto de `updatedAt`. La aceptación y la salida, en hora argentina
        // dentro del pedido (el pedido entregado las exige).
        await qr.query(
          `UPDATE "order" SET "createdAt" = '2026-07-07 01:00:00+00', "updatedAt" = '2026-07-07 02:30:00+00',
                  "acceptedAt" = '2026-07-06 22:10:00', "onTheWayAt" = '2026-07-06 22:20:00',
                  "deliveredAt" = '2026-07-07 02:30:00' WHERE "order_id" = $1`,
          [pedido.orderId],
        );
        await expect(migracion.up(qr)).rejects.toThrow(/abortada/);
        const [col] = (await qr.query(
          `SELECT data_type FROM information_schema.columns WHERE table_name = 'order' AND column_name = 'deliveredAt'`,
        )) as { data_type: string }[];
        expect(col.data_type).toBe('timestamp without time zone');

        // Un reclamo con fracción de segundo (DEFAULT now(), UTC) también aborta.
        await qr.query(
          `UPDATE "order" SET "deliveredAt" = '2026-07-06 23:30:00' WHERE "order_id" = $1`,
          [pedido.orderId],
        );
        const reclamo = (await dataSource.getRepository(Claim).save({
          distributorId,
          orderId: pedido.orderId,
          customerId,
          reason: 'Fuga',
          description: 'x',
        } as Partial<Claim>)) as Claim;
        await qr.query(
          `UPDATE "claims" SET "createdAt" = '2026-07-06 23:45:00.123456' WHERE "claim_id" = $1`,
          [reclamo.claimId],
        );
        await expect(migracion.up(qr)).rejects.toThrow(/abortada/);

        await qr.query(
          `UPDATE "claims" SET "createdAt" = '2026-07-06 23:45:00' WHERE "claim_id" = $1`,
          [reclamo.claimId],
        );
        await migracion.up(qr);
      } finally {
        await qr.release();
      }
    });
  });

  describe('CrearDocumentSequence', () => {
    const restricciones = async (
      qr: ReturnType<DataSource['createQueryRunner']>,
    ) =>
      (await qr.query(
        `SELECT conname, contype, pg_get_constraintdef(oid) AS definicion FROM pg_constraint WHERE conrelid = 'document_sequence'::regclass ORDER BY conname`,
      )) as { conname: string; contype: string; definicion: string }[];

    it('up y down; la migración deja el mismo esquema que la entidad', async () => {
      const migracion = new CrearDocumentSequence1791000100000();
      const qr = dataSource.createQueryRunner();
      try {
        const columnas = `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'document_sequence' ORDER BY column_name`;
        const delEsquema = await restricciones(qr);
        const columnasEsquema = (await qr.query(columnas)) as unknown[];
        expect(delEsquema.map((r) => r.conname)).toEqual([
          'CHK_document_sequence_valores',
          'FK_document_sequence_distributor',
          'PK_document_sequence',
        ]);

        await migracion.down(qr);
        const [{ existe }] = (await qr.query(
          `SELECT to_regclass('document_sequence') IS NOT NULL AS existe`,
        )) as { existe: boolean }[];
        expect(existe).toBe(false);

        await migracion.up(qr);
        // El CHECK lo agrega una migración posterior (ChecksDeLaBase): esta crea el resto.
        expect((await restricciones(qr)).map((r) => r.conname)).toEqual([
          'FK_document_sequence_distributor',
          'PK_document_sequence',
        ]);
        await qr.query(
          `ALTER TABLE "document_sequence" ADD CONSTRAINT "CHK_document_sequence_valores" CHECK ("last_number" >= 0 AND "doc_type" ~ '^[a-z][a-z0-9_]{0,39}$')`,
        );
        expect(await restricciones(qr)).toEqual(delEsquema);
        expect(await qr.query(columnas)).toEqual(columnasEsquema);
      } finally {
        await qr.release();
      }
    });
  });

  describe('DocumentSequenceService', () => {
    let service: DocumentSequenceService;

    beforeEach(() => {
      service = env.app.get(DocumentSequenceService);
    });

    it('N transacciones en paralelo reciben 1..N sin repetidos', async () => {
      const N = 25;
      const numeros = await Promise.all(
        Array.from({ length: N }, () =>
          dataSource.transaction((manager) =>
            service.siguienteNumero(
              manager,
              distributorId,
              DocType.PURCHASE_ORDER,
            ),
          ),
        ),
      );
      expect([...numeros].sort((a, b) => a - b)).toEqual(
        Array.from({ length: N }, (_, i) => i + 1),
      );
    });

    it('cada tipo de documento lleva su propia cuenta', async () => {
      const uno = await dataSource.transaction((m) =>
        service.siguienteNumero(m, distributorId, DocType.TRUCK_LOAD),
      );
      const dos = await dataSource.transaction((m) =>
        service.siguienteNumero(m, distributorId, DocType.TRUCK_LOAD),
      );
      const otro = await dataSource.transaction((m) =>
        service.siguienteNumero(m, distributorId, DocType.EMPLOYEE_FILE),
      );
      expect([uno, dos, otro]).toEqual([1, 2, 1]);
    });

    it('si la transacción se revierte, el número no se pierde', async () => {
      await expect(
        dataSource.transaction(async (manager) => {
          await service.siguienteNumero(
            manager,
            distributorId,
            DocType.DRIVER_SETTLEMENT,
          );
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      const siguiente = await dataSource.transaction((m) =>
        service.siguienteNumero(m, distributorId, DocType.DRIVER_SETTLEMENT),
      );
      expect(siguiente).toBe(1);
    });
  });
});
