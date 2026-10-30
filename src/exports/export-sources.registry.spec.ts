import { ExportSourcesRegistry } from './export-sources.registry';

const vacio = { data: [], total: 0 };

/** Cada servicio de listado, simulado con una página vacía. */
function servicios() {
  return {
    orders: { findAll: jest.fn().mockResolvedValue({ orders: [], total: 0 }) },
    customers: { findAll: jest.fn().mockResolvedValue([[], 0]) },
    deliveries: { findAll: jest.fn().mockResolvedValue([[], 0]) },
    cars: { findAll: jest.fn().mockResolvedValue([]) },
    gasCylinders: {
      findAll: jest.fn().mockResolvedValue({ gasCylinders: [], total: 0 }),
    },
    cylinders: { findAll: jest.fn().mockResolvedValue([[], 0]) },
    stock: {
      resumen: jest.fn().mockResolvedValue([]),
      movimientos: jest.fn().mockResolvedValue(vacio),
    },
    cashBoxes: { findAll: jest.fn().mockResolvedValue(vacio) },
    cashMovements: { consultar: jest.fn().mockResolvedValue(vacio) },
    accounts: { findAll: jest.fn().mockResolvedValue(vacio) },
    settlements: { findAll: jest.fn().mockResolvedValue(vacio) },
    liquidations: { findAll: jest.fn().mockResolvedValue(vacio) },
    fuelLoads: { findAll: jest.fn().mockResolvedValue(vacio) },
    fines: { findAll: jest.fn().mockResolvedValue(vacio) },
    accidents: { findAll: jest.fn().mockResolvedValue(vacio) },
    tires: { findAll: jest.fn().mockResolvedValue(vacio) },
    costs: { tablero: jest.fn().mockResolvedValue([]) },
    claims: { findAll: jest.fn().mockResolvedValue([]) },
    incidents: { findAll: jest.fn().mockResolvedValue([]) },
    purchases: {
      ordenes: jest.fn().mockResolvedValue(vacio),
      recepciones: jest.fn().mockResolvedValue(vacio),
    },
    suppliers: { findAll: jest.fn().mockResolvedValue(vacio) },
    employees: { findAll: jest.fn().mockResolvedValue(vacio) },
    audit: {
      consultar: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    },
    dataAudit: { findAllV2: jest.fn().mockResolvedValue(vacio) },
  };
}

function armar() {
  const s = servicios();
  const registry = new ExportSourcesRegistry(
    ...(Object.values(s) as unknown as ConstructorParameters<
      typeof ExportSourcesRegistry
    >),
  );
  return { s, registry };
}

/** Recurso, filtros mínimos y el mock que tiene que recibir la distribuidora. */
const CASOS: Array<
  [string, Record<string, string>, keyof ReturnType<typeof servicios>, string]
> = [
  ['pedidos', {}, 'orders', 'findAll'],
  ['clientes', {}, 'customers', 'findAll'],
  ['choferes', {}, 'deliveries', 'findAll'],
  ['vehiculos', {}, 'cars', 'findAll'],
  ['garrafas', {}, 'gasCylinders', 'findAll'],
  ['envases', {}, 'cylinders', 'findAll'],
  ['stock-resumen', {}, 'stock', 'resumen'],
  ['stock-movimientos', {}, 'stock', 'movimientos'],
  ['cajas', {}, 'cashBoxes', 'findAll'],
  ['movimientos-caja', {}, 'cashMovements', 'consultar'],
  ['cuentas-corrientes', {}, 'accounts', 'findAll'],
  ['rendiciones', {}, 'settlements', 'findAll'],
  ['liquidaciones', {}, 'liquidations', 'findAll'],
  ['combustible', {}, 'fuelLoads', 'findAll'],
  ['multas', {}, 'fines', 'findAll'],
  ['siniestros', {}, 'accidents', 'findAll'],
  ['neumaticos', {}, 'tires', 'findAll'],
  [
    'costos-flota',
    { from: '2026-10-01', to: '2026-10-31' },
    'costs',
    'tablero',
  ],
  ['reclamos', {}, 'claims', 'findAll'],
  ['incidencias', {}, 'incidents', 'findAll'],
  ['ordenes-compra', {}, 'purchases', 'ordenes'],
  ['recepciones', {}, 'purchases', 'recepciones'],
  ['proveedores', {}, 'suppliers', 'findAll'],
  ['legajos', {}, 'employees', 'findAll'],
  ['auditoria', {}, 'audit', 'consultar'],
  ['auditoria-datos', {}, 'dataAudit', 'findAllV2'],
];

describe('ExportSourcesRegistry', () => {
  it('expone todos los recursos del brief', () => {
    const { registry } = armar();

    expect(registry.recursos().sort()).toEqual(CASOS.map((c) => c[0]).sort());
  });

  it.each(CASOS)(
    '%s lee su listado acotado a la distribuidora',
    async (recurso, filtros, servicio, metodo) => {
      const { s, registry } = armar();
      const fuente = registry.buscar(recurso);

      const consulta = await fuente?.preparar(filtros, 'dist-1');
      const lote = await consulta?.leer(0, 500);

      expect(lote).toEqual({ filas: [], total: 0 });
      const mock = (s[servicio] as unknown as Record<string, jest.Mock>)[
        metodo
      ];
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0]).toContain('dist-1');
      expect(fuente?.encabezados.length).toBeGreaterThan(3);
    },
  );

  it('los encabezados de cada recurso son distintos entre sí', () => {
    const { registry } = armar();

    for (const recurso of registry.recursos()) {
      const titulos = registry
        .buscar(recurso)
        ?.encabezados.map((e) => e.titulo);
      expect(new Set(titulos).size).toBe(titulos?.length);
    }
  });
});
