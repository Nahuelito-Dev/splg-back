import type { FuenteDeExporte } from '../export.types';
import { fuentesDeCompras } from './compras.fuentes';
import { fuentesDeFinanzas } from './finanzas.fuentes';
import { fuentesDeFlota } from './flota.fuentes';
import { fuentesDePersonal } from './personal.fuentes';
import { fuentesDeStock } from './stock.fuentes';

type Mocks = Record<string, jest.Mock>;

function buscar(fuentes: FuenteDeExporte[], recurso: string): FuenteDeExporte {
  const f = fuentes.find((x) => x.recurso === recurso);
  if (!f) throw new Error(`falta ${recurso}`);
  return f;
}

async function filasDe(
  f: FuenteDeExporte,
  filtros: Record<string, unknown> = {},
) {
  const consulta = await f.preparar(filtros, 'd1');
  return consulta.leer(0, 500);
}

describe('fuentes: las columnas leen los campos del listado', () => {
  it('stock-resumen', async () => {
    const stock: Mocks = {
      resumen: jest.fn().mockResolvedValue([
        {
          gasCylinderId: 'g1',
          gasCylinderType: '10kg',
          warehouses: { full: 5, empty: 2, defective: 1 },
          vehicles: { full: 3, empty: 1, defective: 0 },
          physicalFull: 8,
          reserved: 2,
          sellable: 6,
          minimumFull: null,
        },
      ]),
    };
    const f = buscar(fuentesDeStock({ stock } as never), 'stock-resumen');

    expect(await filasDe(f)).toEqual({
      filas: [['10kg', 5, 2, 1, 3, 1, 0, 8, 2, 6, null]],
      total: 1,
    });
  });

  it('stock-movimientos pasa los filtros del listado y la distribuidora', async () => {
    const movimientos = jest.fn().mockResolvedValue({
      total: 1,
      data: [
        {
          occurredAt: new Date('2026-10-27T12:00:00Z'),
          gasCylinderType: '10kg',
          quantity: 4,
          from: { name: 'Depósito' },
          fromCondition: 'full',
          to: null,
          toCondition: null,
          reason: 'sale',
          referenceType: 'order',
          referenceId: 'o1',
          actorName: 'Ana',
          notes: null,
          batchId: 'b1',
          reversedMovementId: null,
        },
      ],
    });
    const f = buscar(
      fuentesDeStock({ stock: { movimientos } } as never),
      'stock-movimientos',
    );

    const lote = await filasDe(f, { reason: 'purchase_receipt' });

    expect(movimientos).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({
        reason: 'purchase_receipt',
        limit: 500,
        page: 1,
      }),
    );
    expect(lote.filas[0].slice(0, 7)).toEqual([
      new Date('2026-10-27T12:00:00Z'),
      '10kg',
      4,
      'Depósito',
      'Llenas',
      undefined,
      null,
    ]);
  });

  it('cuentas-corrientes, rendiciones, órdenes y recepciones devuelven sus filas', async () => {
    const pagina = (fila: object) =>
      jest.fn().mockResolvedValue({ data: [fila], total: 1 });
    const finanzas = fuentesDeFinanzas({
      accounts: {
        findAll: pagina({ businessName: 'ACME', taxId: '30-1', balance: 10 }),
      },
      settlements: {
        findAll: pagina({
          number: 7,
          businessDate: '2026-10-27',
          difference: -5,
        }),
      },
    } as never);
    const compras = fuentesDeCompras({
      purchases: {
        ordenes: pagina({ number: 3, supplierName: 'Gas SA', totalAmount: 99 }),
        recepciones: pagina({
          number: 9,
          supplierName: 'Gas SA',
          purchaseOrderNumber: 3,
        }),
      },
      suppliers: {},
    } as never);

    const cuentas = await filasDe(buscar(finanzas, 'cuentas-corrientes'));
    const rendiciones = await filasDe(buscar(finanzas, 'rendiciones'));
    const ordenes = await filasDe(buscar(compras, 'ordenes-compra'));
    const recepciones = await filasDe(buscar(compras, 'recepciones'));

    expect(cuentas.filas[0].slice(0, 2)).toEqual(['ACME', '30-1']);
    expect(rendiciones.filas[0].slice(0, 2)).toEqual([7, '2026-10-27']);
    expect(rendiciones.filas[0][7]).toBe(-5);
    expect(ordenes.filas[0].slice(0, 2)).toEqual([3, 'Gas SA']);
    expect(recepciones.filas[0][3]).toBe(3);
  });

  it('costos-flota exige from y to como el tablero', async () => {
    const tablero = jest.fn().mockResolvedValue([
      {
        carPatent: 'AB123CD',
        total: 100,
        costPerKm: null,
        insuranceEstimated: true,
      },
    ]);
    const f = buscar(
      fuentesDeFlota({ costs: { tablero } } as never),
      'costos-flota',
    );

    await expect(f.preparar({}, 'd1')).rejects.toThrow();
    const lote = await filasDe(f, { from: '2026-10-01', to: '2026-10-31' });

    expect(tablero).toHaveBeenCalledWith('d1', '2026-10-01', '2026-10-31');
    expect(lote.filas[0][0]).toBe('AB123CD');
    expect(lote.filas[0][8]).toBe(100);
  });

  it('auditoria-datos oculta CBU, documento, CUIL y datos de acceso', async () => {
    const findAllV2 = jest.fn().mockResolvedValue({
      total: 1,
      data: [
        {
          dateTime: new Date('2026-10-27T12:00:00Z'),
          actionType: { id: 1, name: 'UPDATE' },
          user: null,
          entity: 'Employee',
          recordId: 'e1',
          ip: null,
          details: [
            { field: 'bankCbu', oldValue: '0170001', newValue: '0170002' },
            { field: 'documentNumber', oldValue: '30111222', newValue: null },
            { field: 'cuil', oldValue: '20-1', newValue: '20-2' },
            { field: 'firebaseUid', oldValue: 'abc', newValue: 'def' },
            { field: 'lastName', oldValue: 'Gomez', newValue: 'Perez' },
          ],
        },
      ],
    });
    const f = buscar(
      fuentesDePersonal({ dataAudit: { findAllV2 } } as never),
      'auditoria-datos',
    );

    const [cambios] = (await filasDe(f)).filas[0].slice(12);

    expect(cambios).toBe(
      [
        'bankCbu: valor oculto → valor oculto',
        'documentNumber: valor oculto → valor oculto',
        'cuil: valor oculto → valor oculto',
        'firebaseUid: valor oculto → valor oculto',
        'lastName: Gomez → Perez',
      ].join(' | '),
    );
  });

  it('auditoria-datos resume los cambios campo por campo', async () => {
    const findAllV2 = jest.fn().mockResolvedValue({
      total: 1,
      data: [
        {
          dateTime: new Date('2026-10-27T12:00:00Z'),
          actionType: { id: 1, name: 'UPDATE' },
          user: { fullName: 'Ana', email: 'a@x.com' },
          entity: 'Order',
          recordId: 'o1',
          ip: '1.1.1.1',
          details: [
            { field: 'status', oldValue: 'pending', newValue: 'accepted' },
            { field: 'note', oldValue: null, newValue: 'x' },
          ],
        },
      ],
    });
    const f = buscar(
      fuentesDePersonal({ dataAudit: { findAllV2 } } as never),
      'auditoria-datos',
    );

    const lote = await filasDe(f);

    expect(lote.filas[0][12]).toBe('status: pending → accepted | note: ∅ → x');
  });
  it('auditoria-datos acepta el filtro origin y exporta el origen técnico', async () => {
    const findAllV2 = jest.fn().mockResolvedValue({
      total: 1,
      data: [
        {
          dateTime: new Date('2026-10-30T12:00:00Z'),
          actionType: { id: 2, name: 'Modificación' },
          user: null,
          entity: 'Warehouse',
          recordId: 'w1',
          ip: null,
          origin: 'direct',
          source: 'db',
          tableName: 'warehouse',
          dbUser: 'postgres',
          appName: 'psql',
          details: [{ field: 'name', oldValue: 'A', newValue: 'B' }],
        },
      ],
    });
    const f = buscar(
      fuentesDePersonal({ dataAudit: { findAllV2 } } as never),
      'auditoria-datos',
    );

    const lote = await filasDe(f, { origin: 'direct' });

    expect(findAllV2).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'direct' }),
      'd1',
    );
    expect(lote.filas[0].slice(7, 12)).toEqual([
      'Directo en la base',
      'Base de datos (trigger)',
      'Depósito',
      'postgres',
      'psql',
    ]);
  });

  it('auditoria muestra el rol y el resultado con su texto (el chofer se llama «Chofer»)', async () => {
    const consultar = jest.fn().mockResolvedValue({
      total: 2,
      items: ['delivery', 'super_admin'].map((rol) => ({
        createdAt: new Date('2026-10-30T12:00:00Z'),
        httpMethod: 'PATCH',
        resource: 'orders',
        actorRole: rol,
        result: 'success',
        statusCode: 200,
        details: [],
      })),
    });
    const f = buscar(
      fuentesDePersonal({ audit: { consultar } } as never),
      'auditoria',
    );

    const lote = await filasDe(f);

    expect(lote.filas.map((fila) => [fila[6], fila[9]])).toEqual([
      ['Chofer', 'Exitosa'],
      ['Super administrador', 'Exitosa'],
    ]);
  });

  it('auditoria-datos: «Entidad» y «Tabla» salen con el mismo nombre, y el id de tabla no se cuela', async () => {
    const findAllV2 = jest.fn().mockResolvedValue({
      total: 2,
      data: [
        ['Claim', 'claims'],
        ['GasCylinder', 'gas_cylinder'],
      ].map(([entity, tableName]) => ({
        dateTime: new Date('2026-10-30T12:00:00Z'),
        actionType: { id: 2, name: 'Modificación' },
        user: null,
        entity,
        recordId: 'r1',
        ip: null,
        origin: 'user',
        source: 'app',
        tableName,
        dbUser: null,
        appName: null,
        details: [],
      })),
    });
    const f = buscar(
      fuentesDePersonal({ dataAudit: { findAllV2 } } as never),
      'auditoria-datos',
    );

    const lote = await filasDe(f);

    expect(lote.filas.map((fila) => [fila[4], fila[9]])).toEqual([
      ['Reclamo', 'Reclamo'],
      ['Garrafa (producto)', 'Garrafa (producto)'],
    ]);
  });

  it('auditoria-datos rechaza un origin desconocido', async () => {
    const f = buscar(
      fuentesDePersonal({ dataAudit: { findAllV2: jest.fn() } } as never),
      'auditoria-datos',
    );

    await expect(f.preparar({ origin: 'otro' }, 'd1')).rejects.toThrow();
  });
});
