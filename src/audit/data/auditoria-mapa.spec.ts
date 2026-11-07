import { join } from 'path';
import { DataSource } from 'typeorm';
import { TABLAS_EXCLUIDAS } from './audit-exclusions';
import { construirMapa, MapaDeAuditoria } from './auditoria-mapa';
import mapaGuardado from './auditoria-mapa.datos.json';
import { MAPA as mapaDeLaMigracion } from '../../migrations/1795000000009-AuditoriaDeLosIntentos';

describe('mapa de la auditoría por triggers', () => {
  let dataSource: DataSource;
  let mapa: MapaDeAuditoria;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      entities: [join(__dirname, '../../**/*.entity.ts')],
    });
    await (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
    mapa = construirMapa(dataSource.entityMetadatas);
  });

  // Si falla: se agregó una entidad o una columna sin regenerar el mapa.
  // `npm run auditoria:mapa -- --migracion <Nombre>` y correr la migración.
  it('el mapa guardado coincide con las entidades de TypeORM', () => {
    expect(mapaGuardado).toEqual(JSON.parse(JSON.stringify(mapa)));
  });

  it('toda tabla de una entidad queda auditada salvo las excluidas', () => {
    const tablas = new Set(mapa.entities.map((e) => e.table));
    for (const m of dataSource.entityMetadatas) {
      expect(tablas.has(m.tableName)).toBe(!TABLAS_EXCLUIDAS.has(m.tableName));
    }
  });

  it('conserva el nombre de la clase y el de la propiedad que usa el panel', () => {
    expect(mapa.entities.find((e) => e.table === 'claims')?.entity).toBe(
      'Claim',
    );
    expect(
      mapa.fields.find(
        (f) => f.table === 'supplier' && f.column === 'photo_key',
      )?.property,
    ).toBe('photoKey');
  });

  it('no guarda las columnas excluidas ni las fechas de sistema, y oculta los secretos', () => {
    const de = (tabla: string) =>
      mapa.fields.filter((f) => f.table === tabla).map((f) => f.property);
    expect(de('order')).not.toEqual(
      expect.arrayContaining(['receiverName', 'receiverDocument']),
    );
    expect(de('delivery')).not.toContain('location');
    expect(de('supplier')).not.toContain('createdAt');
    expect(
      mapa.fields.find(
        (f) => f.table === 'order' && f.property === 'deliveryCode',
      )?.secret,
    ).toBe(true);
  });

  it('el renglón de un pedido lleva el pedido y toma la distribuidora del request', () => {
    const renglon = mapa.entities.find((e) => e.table === 'order_item');
    expect(renglon).toMatchObject({
      distributorMode: 'request',
      orderProperty: 'orderId',
      orderColumn: 'order_id',
    });
  });

  it('la clave compuesta guarda sus columnas en orden', () => {
    const lectura = mapa.entities.find(
      (e) => e.table === 'admin_notification_read',
    );
    expect(lectura?.pk).toHaveLength(2);
  });

  it('el mapa embebido en la migración coincide con el generado desde las entidades', () => {
    expect(mapaDeLaMigracion).toEqual(JSON.parse(JSON.stringify(mapa)));
  });

  it('los renglones sin distribuidora propia la toman del padre por su FK', () => {
    const hijas = [
      'customer_account_allocation',
      'driver_settlement_collection',
      'driver_settlement_expense',
      'driver_settlement_order',
      'purchase_order_item',
      'purchase_receipt_item',
      'truck_load_item',
    ];
    for (const tabla of hijas) {
      const e = mapa.entities.find((x) => x.table === tabla);
      expect(e?.distributorMode).toBe('parent');
      expect(e?.parentTable).toBeTruthy();
      expect(e?.parentFkColumn).toBeTruthy();
      expect(e?.parentPkColumn).toBeTruthy();
      expect(e?.parentDistributorColumn).toBe('distributor_id');
    }
  });

  it('lo de la persona o global sigue sin distribuidora', () => {
    const sin = mapa.entities
      .filter((e) => e.distributorMode === 'none')
      .map((e) => e.table)
      .sort();
    expect(sin).toEqual(['customer', 'role', 'user', 'user_address']);
  });
});
