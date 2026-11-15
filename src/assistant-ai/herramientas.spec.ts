import type { DataSource } from 'typeorm';
import { ajustesDeLaBandejaPorDefecto } from '../chat/application/company-chat-settings.service';
import {
  CoverageZone,
  CoverageZoneSurchargeType,
} from '../coverage-zone/entities/coverage-zone.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import type { GasCylinderService } from '../gascylinder/gascylinder.service';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { TimeSlot } from '../time-slot/entities/time-slot.entity';
import {
  type ContextoDeLasHerramientas,
  ESTADO_DE_MI_PEDIDO,
  HerramientasDelAsistente,
  herramientasDelCanal,
  HORARIOS_Y_ZONAS,
  MEDIOS_DE_PAGO,
  pedidoBuscado,
  pesos,
  porcentaje,
  PRECIOS_VIGENTES,
} from './herramientas';

const EMPRESA = 'dist-a';
const OTRA_EMPRESA = 'dist-b';
const CLIENTE = 'cli-1';
const OTRO_CLIENTE = 'cli-2';

interface FilaDePedido {
  orderId: string;
  distributorId: string;
  customerId: string;
  status: OrderStatus;
  createdAt: Date;
  totalAmount: number;
  scheduledDate: string | null;
  timeSlot: { name: string; startTime: string; endTime: string } | null;
  delivery: { user: { fullName: string } } | null;
}

const pedido = (
  orderId: string,
  distributorId: string,
  customerId: string,
  extra: Partial<FilaDePedido> = {},
): FilaDePedido => ({
  orderId,
  distributorId,
  customerId,
  status: OrderStatus.PENDING,
  createdAt: new Date('2026-11-10T12:00:00Z'),
  totalAmount: 12345.5,
  scheduledDate: null,
  timeSlot: null,
  delivery: null,
  ...extra,
});

const PEDIDOS: FilaDePedido[] = [
  pedido('aaaaaaaa-0000-4000-8000-0000000abc01', EMPRESA, CLIENTE, {
    status: OrderStatus.ON_THE_WAY,
    createdAt: new Date('2026-11-14T12:00:00Z'),
    scheduledDate: '2026-11-15',
    timeSlot: { name: 'Mañana', startTime: '09:00:00', endTime: '13:00:00' },
    delivery: { user: { fullName: 'Juan Carlos Pérez' } },
  }),
  pedido('aaaaaaaa-0000-4000-8000-0000000abc02', EMPRESA, CLIENTE, {
    status: OrderStatus.DELIVERED,
    delivery: { user: { fullName: 'Ana Gómez' } },
  }),
  // Del mismo número corto que el primero, pero de OTRO cliente y de OTRA empresa.
  pedido('bbbbbbbb-0000-4000-8000-0000000abc01', EMPRESA, OTRO_CLIENTE),
  pedido('cccccccc-0000-4000-8000-0000000abc01', OTRA_EMPRESA, CLIENTE),
];

/**
 * Un query builder de mentira que filtra los pedidos con los parámetros que
 * le pasa la herramienta, como haría la base: si la herramienta no filtra por
 * empresa y cliente, se cuelan los ajenos.
 */
interface QbFalso {
  condiciones: Array<{ sql: string; params: Record<string, string> }>;
  leftJoinAndSelect: jest.Mock<QbFalso>;
  where: jest.Mock<QbFalso, [string, Record<string, string>]>;
  andWhere: jest.Mock<QbFalso, [string, Record<string, string>]>;
  orderBy: jest.Mock<QbFalso>;
  addOrderBy: jest.Mock<QbFalso>;
  take: jest.Mock<QbFalso, [number]>;
  getMany: jest.Mock<Promise<FilaDePedido[]>>;
}

function qbDePedidos(filas: FilaDePedido[]): QbFalso {
  const condiciones: Array<{ sql: string; params: Record<string, string> }> =
    [];
  let tope = Infinity;
  const qb: QbFalso = {
    condiciones,
    leftJoinAndSelect: jest.fn(() => qb),
    where: jest.fn((sql: string, params: Record<string, string>) => {
      condiciones.push({ sql, params });
      return qb;
    }),
    andWhere: jest.fn((sql: string, params: Record<string, string>) => {
      condiciones.push({ sql, params });
      return qb;
    }),
    orderBy: jest.fn(() => qb),
    addOrderBy: jest.fn(() => qb),
    take: jest.fn((n: number) => {
      tope = n;
      return qb;
    }),
    getMany: jest.fn(() => {
      const p: Record<string, string | undefined> = {};
      for (const c of condiciones) Object.assign(p, c.params);
      return Promise.resolve(
        filas
          .filter((f) => !p.empresa || f.distributorId === p.empresa)
          .filter((f) => !p.cliente || f.customerId === p.cliente)
          .filter((f) => !p.id || f.orderId === p.id)
          .filter(
            (f) => !p.corto || f.orderId.slice(-6).toUpperCase() === p.corto,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, tope),
      );
    }),
  };
  return qb;
}

function armar(filas: FilaDePedido[] = PEDIDOS) {
  const qb = qbDePedidos(filas);
  const repos = new Map<
    unknown,
    { find: jest.Mock; createQueryBuilder?: jest.Mock<QbFalso> }
  >([
    [Order, { find: jest.fn(), createQueryBuilder: jest.fn(() => qb) }],
    [
      TimeSlot,
      {
        find: jest.fn(() =>
          Promise.resolve([
            { name: 'Mañana', startTime: '09:00:00', endTime: '13:00:00' },
          ]),
        ),
      },
    ],
    [
      CoverageZone,
      {
        find: jest.fn(() =>
          Promise.resolve([
            {
              name: 'Centro',
              surchargeType: CoverageZoneSurchargeType.FIXED,
              surchargeValue: 0,
              validFrom: null,
              validUntil: null,
            },
            {
              name: 'Itaembé',
              surchargeType: CoverageZoneSurchargeType.PERCENTAGE,
              surchargeValue: 12.5,
              validFrom: new Date('2026-01-01T00:00:00Z'),
              validUntil: null,
            },
            {
              name: 'Garupá',
              surchargeType: CoverageZoneSurchargeType.FIXED,
              surchargeValue: 1500,
              validFrom: null,
              validUntil: new Date('2026-12-31T00:00:00Z'),
            },
            {
              name: 'Vencida',
              surchargeType: CoverageZoneSurchargeType.FIXED,
              surchargeValue: 100,
              validFrom: null,
              validUntil: new Date('2026-01-01T00:00:00Z'),
            },
            {
              name: 'Futura',
              surchargeType: CoverageZoneSurchargeType.FIXED,
              surchargeValue: 100,
              validFrom: new Date('2027-01-01T00:00:00Z'),
              validUntil: null,
            },
          ]),
        ),
      },
    ],
    [
      GasCylinder,
      {
        find: jest.fn(() =>
          Promise.resolve([
            {
              gasCylinderId: 'g1',
              type: '10kg',
              weight: 10,
              price: 15000,
              description: null,
              stock: 4,
              promotions: [{ quantity: 3, discountPercentage: 10 }],
            },
          ]),
        ),
      },
    ],
  ]);
  const dataSource = {
    getRepository: jest.fn((e: unknown) => repos.get(e)),
  } as unknown as DataSource;
  const garrafas = {
    mediosDePago: jest.fn(() =>
      Promise.resolve([
        { name: 'Efectivo', key: 'CASH', surcharge: 0 },
        { name: 'Mercado Pago', key: 'MERCADOPAGO', surcharge: 2.5 },
      ]),
    ),
  };
  return {
    herramientas: new HerramientasDelAsistente(
      dataSource,
      garrafas as unknown as GasCylinderService,
    ),
    qb,
    repos,
    garrafas,
  };
}

const contexto = (
  extra: Partial<ContextoDeLasHerramientas> = {},
): ContextoDeLasHerramientas => ({
  distributorId: EMPRESA,
  customerUserId: CLIENTE,
  orderId: null,
  ajustes: Object.assign(ajustesDeLaBandejaPorDefecto(EMPRESA), {
    businessHours: [
      { weekday: 2, opensAt: '14:00', closesAt: '18:00' },
      { weekday: 1, opensAt: '08:00', closesAt: '12:00' },
    ],
  }),
  // Martes 10 de noviembre de 2026, 15:00 en Argentina.
  ahora: new Date('2026-11-10T18:00:00Z'),
  ...extra,
});

describe('Herramientas del asistente (sólo lectura)', () => {
  describe('estado_de_mi_pedido: aislamiento', () => {
    it('sin número: sólo los pedidos del cliente de la conversación y de esta empresa, del más nuevo al más viejo', async () => {
      const { herramientas, qb } = armar();
      const r = await herramientas.ejecutar(
        contexto(),
        ESTADO_DE_MI_PEDIDO,
        {},
      );
      expect(r.error).toBe(false);
      expect(r.datos).toEqual([
        {
          pedido: '0ABC01',
          estado: 'En camino',
          fechaDeEntrega: '2026-11-15',
          franja: 'Mañana (09:00 a 13:00)',
          chofer: 'Juan',
          total: '$ 12.345,50',
        },
        {
          pedido: '0ABC02',
          estado: 'Entregado',
          fechaDeEntrega: null,
          franja: null,
          chofer: null,
          total: '$ 12.345,50',
        },
      ]);
      expect(qb.condiciones.slice(0, 2)).toEqual([
        { sql: 'o.distributorId = :empresa', params: { empresa: EMPRESA } },
        { sql: 'o.customerId = :cliente', params: { cliente: CLIENTE } },
      ]);
    });

    it('con el número corto de un pedido de otro cliente u otra empresa: no lo encuentra (sólo el suyo)', async () => {
      const { herramientas } = armar();
      const r = await herramientas.ejecutar(contexto(), ESTADO_DE_MI_PEDIDO, {
        pedido: '#0abc01',
      });
      expect(r.datos).toHaveLength(1);
      expect(r.datos).toEqual([expect.objectContaining({ pedido: '0ABC01' })]);
      const otro = await herramientas.ejecutar(
        contexto({ customerUserId: OTRO_CLIENTE }),
        ESTADO_DE_MI_PEDIDO,
        { pedido: '0ABC02' },
      );
      expect(otro).toEqual({
        datos: {
          error: 'No hay un pedido con ese número entre los de esta persona',
        },
        error: true,
      });
    });

    it('nunca devuelve un pedido ajeno, aunque el modelo mande el id completo de otro cliente o empresa', async () => {
      const { herramientas } = armar();
      for (const id of [
        'bbbbbbbb-0000-4000-8000-0000000abc01',
        'cccccccc-0000-4000-8000-0000000abc01',
      ]) {
        const r = await herramientas.ejecutar(contexto(), ESTADO_DE_MI_PEDIDO, {
          pedido: id.toUpperCase(),
        });
        expect(r.error).toBe(true);
      }
      const suyo = await herramientas.ejecutar(
        contexto(),
        ESTADO_DE_MI_PEDIDO,
        {
          pedido: 'aaaaaaaa-0000-4000-8000-0000000abc02',
        },
      );
      expect(suyo.datos).toEqual([
        expect.objectContaining({ pedido: '0ABC02' }),
      ]);
    });

    it('en una conversación por pedido, sin número, es ese pedido', async () => {
      const { herramientas } = armar();
      const r = await herramientas.ejecutar(
        contexto({ orderId: 'aaaaaaaa-0000-4000-8000-0000000abc02' }),
        ESTADO_DE_MI_PEDIDO,
        {},
      );
      expect(r.datos).toEqual([expect.objectContaining({ pedido: '0ABC02' })]);
    });

    it('número inválido, sin cliente o sin pedidos', async () => {
      const { herramientas, qb } = armar();
      expect(
        await herramientas.ejecutar(contexto(), ESTADO_DE_MI_PEDIDO, {
          pedido: 'DROP TABLE',
        }),
      ).toEqual({
        datos: {
          error:
            'Ese número de pedido no es válido: son 6 caracteres, como figura en la app',
        },
        error: true,
      });
      expect(
        await herramientas.ejecutar(
          contexto({ customerUserId: null }),
          ESTADO_DE_MI_PEDIDO,
          {},
        ),
      ).toEqual({
        datos: { error: 'Esta conversación no es con un cliente' },
        error: true,
      });
      expect(qb.getMany).not.toHaveBeenCalled();
      const vacio = await armar([]).herramientas.ejecutar(
        contexto(),
        ESTADO_DE_MI_PEDIDO,
        null,
      );
      expect(vacio).toEqual({
        datos: { error: 'Esta persona no tiene pedidos' },
        error: false,
      });
    });

    it('el chofer (nombre de pila) sólo mientras lo lleva', async () => {
      const { herramientas } = armar([
        pedido('aaaaaaaa-0000-4000-8000-000000000001', EMPRESA, CLIENTE, {
          status: OrderStatus.ACCEPTED,
          delivery: { user: { fullName: '  ' } },
        }),
      ]);
      const r = await herramientas.ejecutar(
        contexto(),
        ESTADO_DE_MI_PEDIDO,
        {},
      );
      expect(r.datos).toEqual([expect.objectContaining({ chofer: null })]);
    });
  });

  it('horarios_y_zonas: horario de la empresa, franjas y zonas vigentes de esa empresa con su recargo', async () => {
    const { herramientas, repos } = armar();
    // Martes 20:00 en Argentina: ya cerró, vuelve el lunes.
    const r = await herramientas.ejecutar(
      contexto({ ahora: new Date('2026-11-10T23:00:00Z') }),
      HORARIOS_Y_ZONAS,
      {},
    );
    expect(r).toEqual({
      datos: {
        atiendeAhora: false,
        proximaAtencion: expect.stringContaining('lunes') as unknown,
        horarioDeAtencion: [
          'lunes de 08:00 a 12:00',
          'martes de 14:00 a 18:00',
        ],
        franjasDeEntrega: ['Mañana: 09:00 a 13:00'],
        zonasDeCobertura: [
          { zona: 'Centro', recargo: 'sin recargo' },
          { zona: 'Itaembé', recargo: '12,5 %' },
          { zona: 'Garupá', recargo: '$ 1.500,00' },
        ],
      },
      error: false,
    });
    expect(repos.get(TimeSlot)?.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { distributorId: EMPRESA, isActive: true },
      }),
    );
    expect(repos.get(CoverageZone)?.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          distributorId: EMPRESA,
          isActive: true,
        }) as unknown,
      }),
    );
  });

  it('horarios_y_zonas sin franjas cargadas: atiende siempre', async () => {
    const { herramientas } = armar();
    const r = await herramientas.ejecutar(
      contexto({ ajustes: ajustesDeLaBandejaPorDefecto(EMPRESA) }),
      HORARIOS_Y_ZONAS,
      {},
    );
    expect(r.datos).toMatchObject({
      atiendeAhora: true,
      proximaAtencion: null,
      horarioDeAtencion: 'Todos los días, todo el día',
    });
  });

  it('precios_vigentes: los de la empresa, con las promociones como las calcula el back', async () => {
    const { herramientas, repos } = armar();
    const r = await herramientas.ejecutar(contexto(), PRECIOS_VIGENTES, {});
    expect(r.datos).toEqual([
      {
        producto: '10kg',
        precio: '$ 15.000,00',
        promociones: ['desde 3 unidades: $ 13.500,00 cada una'],
        hayStock: true,
      },
    ]);
    expect(repos.get(GasCylinder)?.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { distributorId: EMPRESA, isActive: true },
      }),
    );
  });

  it('medios_de_pago: los de la empresa con su recargo', async () => {
    const { herramientas, garrafas } = armar();
    const r = await herramientas.ejecutar(contexto(), MEDIOS_DE_PAGO, {});
    expect(r.datos).toEqual([
      { medio: 'Efectivo', recargo: 'sin recargo' },
      { medio: 'Mercado Pago', recargo: '2,5 %' },
    ]);
    expect(garrafas.mediosDePago).toHaveBeenCalledWith(EMPRESA);
  });

  it('una herramienta que no existe vuelve como error', async () => {
    const { herramientas } = armar();
    expect(await herramientas.ejecutar(contexto(), 'borrar_todo', {})).toEqual({
      datos: { error: 'La herramienta borrar_todo no existe' },
      error: true,
    });
  });

  it('en el soporte (C1) sólo está pasar_a_persona; con los clientes, las cinco', () => {
    expect(herramientasDelCanal('soporte').map((h) => h.name)).toEqual([
      'pasar_a_persona',
    ]);
    expect(herramientasDelCanal('clientes').map((h) => h.name)).toEqual([
      'estado_de_mi_pedido',
      'horarios_y_zonas',
      'precios_vigentes',
      'medios_de_pago',
      'pasar_a_persona',
    ]);
  });

  it('formatos: pesos con decimal, porcentajes y números de pedido', () => {
    expect(pesos(0.1 + 0.2)).toBe('$ 0,30');
    expect(pesos('1234567.891')).toBe('$ 1.234.567,89');
    expect(pesos(-50)).toBe('-$ 50,00');
    expect(porcentaje(10)).toBe('10 %');
    expect(pedidoBuscado(' #abc123 ')).toBe('ABC123');
    expect(pedidoBuscado('AAAAAAAA-0000-4000-8000-0000000ABC01')).toBe(
      'aaaaaaaa-0000-4000-8000-0000000abc01',
    );
    expect(pedidoBuscado('12345')).toBeNull();
  });
});
