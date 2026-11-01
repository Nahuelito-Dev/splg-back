import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FindOperator } from 'typeorm';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { OrderStatus } from '../order/entities/order.entity';
import {
  RouteBatch,
  RouteBatchCloseReason,
  RouteBatchStatus,
} from '../order/entities/route-batch.entity';
import { RouteBatchOffer } from '../order/entities/route-batch-offer.entity';
import { RouteBatchStop } from '../order/entities/route-batch-stop.entity';
import { RouteBatchService } from './route-batch.service';

/**
 * El servicio corre contra un "mundo" en memoria: pedidos, lotes, paradas y
 * ofertas viven en arreglos y los repositorios, la transacción y las consultas
 * crudas de PostGIS se simulan encima. Así cada regla se prueba con el estado
 * real que deja (no sólo con "se llamó a tal método").
 */

const D1 = 'dist-1';
const OCHO = Date.UTC(2026, 10, 3, 11, 0, 0);
const HORA = 3_600_000;

interface PedidoSim {
  orderId: string;
  status: OrderStatus;
  deliveryId: string | null;
  lat: number;
  lng: number;
  pesoKg: number;
  slotStartMs: number;
  slotEndMs: number;
  /** M1 le está ofreciendo el pedido a un chofer. */
  ofertaDeM1: boolean;
}

interface ChoferSim {
  userId: string;
  deliveryId: string;
  distributorId: string;
  capacidadKg: number | null;
  habilitado: boolean;
}

const pedidoSim = (
  orderId: string,
  over: Partial<PedidoSim> = {},
): PedidoSim => ({
  orderId,
  status: OrderStatus.PENDING,
  deliveryId: null,
  lat: -27.38,
  lng: -55.93,
  pesoKg: 10,
  slotStartMs: OCHO,
  slotEndMs: OCHO + 4 * HORA,
  ofertaDeM1: false,
  ...over,
});

function cumple(fila: object, where: Record<string, unknown>): boolean {
  const f = fila as Record<string, unknown>;
  return Object.entries(where).every(([k, esperado]) => {
    if (esperado instanceof FindOperator) {
      return (esperado.value as unknown[]).includes(f[k]);
    }
    return f[k] === esperado;
  });
}

function crearMundo(opciones: {
  pedidos: PedidoSim[];
  choferes: ChoferSim[];
  parametros?: Record<string, number>;
}) {
  const pedidos = new Map(opciones.pedidos.map((p) => [p.orderId, p]));
  const lotes: RouteBatch[] = [];
  const paradas: RouteBatchStop[] = [];
  const ofertas: RouteBatchOffer[] = [];
  const choferes = opciones.choferes;
  let elegibles: string[] = choferes.map((c) => c.userId);
  const parametros = {
    enabled: 1,
    batchingHoldMinutes: 60,
    maxBatchSize: 4,
    groupingRadiusKm: 3,
    slotToleranceMinutes: 60,
    offerTtlSeconds: 60,
    evaluationFrequencyMinutes: 15,
    ...opciones.parametros,
  };
  const registro = {
    asignaciones: [] as Array<{ orderId: string; deliveryId: string }>,
    devueltosAM1: [] as string[],
    ofertasAvisadas: [] as Array<{ deliveryId: string; batchId: string }>,
    ofertasCerradas: [] as Array<{ userId: string; motivo: string }>,
    lotesSinChofer: [] as string[],
    asignacionesQueFallan: new Map<string, Error>(),
    ultimoAvisoDeAsignacion: [] as string[][],
  };

  const km = (a: PedidoSim, b: PedidoSim): number => {
    const dLat = (a.lat - b.lat) * 111;
    const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLng);
  };

  const query = jest.fn(
    (sql: string, params: unknown[] = []): Promise<unknown> => {
      if (sql.includes('SELECT DISTINCT o."distributor_id"')) {
        return Promise.resolve([{ distributorId: D1 }]);
      }
      if (sql.includes('AS "slotStartMs"')) {
        const libres = [...pedidos.values()].filter(
          (p) =>
            p.status === OrderStatus.PENDING &&
            !p.deliveryId &&
            !p.ofertaDeM1 &&
            !paradas.some((s) => s.orderId === p.orderId && s.active) &&
            !paradas.some(
              (s) =>
                s.orderId === p.orderId &&
                lotes.some(
                  (l) =>
                    l.batchId === s.batchId &&
                    l.status === RouteBatchStatus.DISSOLVED &&
                    (l.closeReason === RouteBatchCloseReason.EXHAUSTED ||
                      l.closeReason === RouteBatchCloseReason.ADMIN),
                ),
            ),
        );
        return Promise.resolve(
          libres
            .sort((a, b) => a.slotStartMs - b.slotStartMs)
            .map((p, i) => ({
              orderId: p.orderId,
              slotStartMs: String(p.slotStartMs),
              slotEndMs: String(p.slotEndMs),
              lat: String(p.lat),
              lng: String(p.lng),
              createdAtMs: String(i),
              weightKg: String(p.pesoKg),
            })),
        );
      }
      if (sql.includes('ST_Distance')) {
        const ids = params[0] as string[];
        const filas: Array<{ a: string; b: string; km: string }> = [];
        for (const a of ids) {
          for (const b of ids) {
            if (a < b) {
              filas.push({
                a,
                b,
                km: String(km(pedidos.get(a)!, pedidos.get(b)!)),
              });
            }
          }
        }
        return Promise.resolve(filas);
      }
      if (sql.includes('UNION')) {
        const ocupados = [
          ...ofertas
            .filter((o) => o.status === ProposalStatus.PENDING)
            .map((o) => o.deliveryId),
          ...lotes
            .filter(
              (l) => l.status === RouteBatchStatus.ASSIGNED && l.deliveryId,
            )
            .map((l) => l.deliveryId as string),
        ];
        return Promise.resolve(ocupados.map((deliveryId) => ({ deliveryId })));
      }
      if (sql.includes('FOR UPDATE OF o')) {
        const ids = params[0] as string[];
        return Promise.resolve(
          ids
            .map((id) => pedidos.get(id))
            .filter(
              (p): p is PedidoSim =>
                !!p &&
                p.status === OrderStatus.PENDING &&
                !p.deliveryId &&
                !p.ofertaDeM1,
            )
            .map((p) => ({ orderId: p.orderId })),
        );
      }
      if (sql.includes('SUM(oi."quantity"')) {
        const ids = params[0] as string[];
        return Promise.resolve([
          {
            peso: String(
              ids.reduce((acc, id) => acc + (pedidos.get(id)?.pesoKg ?? 0), 0),
            ),
          },
        ]);
      }
      if (sql.includes('ST_Y("deliveryPoint")')) {
        const p = pedidos.get(params[0] as string);
        return Promise.resolve(
          p ? [{ lat: String(p.lat), lng: String(p.lng) }] : [],
        );
      }
      if (sql.includes(`b."status" = 'offered'`)) {
        return Promise.resolve(
          lotes
            .filter(
              (l) =>
                l.status === RouteBatchStatus.OFFERED &&
                !ofertas.some(
                  (o) =>
                    o.batchId === l.batchId &&
                    o.status === ProposalStatus.PENDING,
                ),
            )
            .map((l) => ({ batchId: l.batchId })),
        );
      }
      if (sql.includes(`b."status" = 'assigned'`)) {
        return Promise.resolve(
          lotes
            .filter(
              (l) =>
                l.status === RouteBatchStatus.ASSIGNED &&
                paradas
                  .filter((s) => s.batchId === l.batchId && s.active)
                  .every((s) =>
                    [OrderStatus.DELIVERED, OrderStatus.CANCELLED].includes(
                      pedidos.get(s.orderId)!.status,
                    ),
                  ),
            )
            .map((l) => ({ batchId: l.batchId })),
        );
      }
      throw new Error(`Consulta no simulada: ${sql.slice(0, 80)}`);
    },
  );

  const aplicar = <T extends object>(
    filas: T[],
    where: Record<string, unknown>,
    cambios: Partial<T>,
  ): number => {
    const afectadas = filas.filter((f) => cumple(f, where));
    afectadas.forEach((f) => Object.assign(f, cambios));
    return afectadas.length;
  };

  const repoDe = <T extends object>(filas: T[]) => ({
    find: jest.fn(
      (
        opts: {
          where?: Record<string, unknown>;
          order?: Record<string, string>;
        } = {},
      ) =>
        Promise.resolve(
          filas
            .filter((f) => cumple(f, opts.where ?? {}))
            .sort((a, b) => {
              const clave = Object.keys(opts.order ?? {})[0];
              if (!clave) return 0;
              return (
                Number((a as Record<string, unknown>)[clave]) -
                Number((b as Record<string, unknown>)[clave])
              );
            }),
        ),
    ),
    findOne: jest.fn((opts: { where: Record<string, unknown> }) =>
      Promise.resolve(filas.find((f) => cumple(f, opts.where)) ?? null),
    ),
    count: jest.fn((opts: { where: Record<string, unknown> }) =>
      Promise.resolve(filas.filter((f) => cumple(f, opts.where)).length),
    ),
    exist: jest.fn((opts: { where: Record<string, unknown> }) =>
      Promise.resolve(filas.some((f) => cumple(f, opts.where))),
    ),
    update: jest.fn((where: Record<string, unknown>, cambios: Partial<T>) =>
      Promise.resolve({ affected: aplicar(filas, where, cambios) }),
    ),
  });

  const batches = repoDe(lotes);
  const stops = repoDe(paradas);
  const offers = {
    ...repoDe(ofertas),
    createQueryBuilder: jest.fn(() => {
      const q = {
        where: () => q,
        andWhere: () => q,
        getMany: () =>
          Promise.resolve(
            ofertas.filter(
              (o) =>
                o.status === ProposalStatus.PENDING &&
                o.expiresAt.getTime() <= ahoraDelTest.getTime(),
            ),
          ),
      };
      return q;
    }),
  };
  // Las ofertas guardadas con `find({where: {batchId}})` y los `update` por id
  // usan el mismo almacén.
  let ahoraDelTest = new Date();

  const guardar = <T extends object>(x: T): T => {
    const e = x as Record<string, unknown>;
    if (x instanceof RouteBatch) {
      e.batchId ??= randomUUID();
      e.createdAt ??= new Date();
      e.closedAt ??= null;
      e.closeReason ??= null;
      lotes.push(e as unknown as RouteBatch);
    } else if (x instanceof RouteBatchStop) {
      e.stopId ??= randomUUID();
      paradas.push(e as unknown as RouteBatchStop);
    } else if (x instanceof RouteBatchOffer) {
      e.offerId ??= randomUUID();
      ofertas.push(e as unknown as RouteBatchOffer);
    }
    return x;
  };

  const manager = {
    query,
    create: jest.fn((entidad: new () => object, datos: object) =>
      Object.assign(new entidad(), datos),
    ),
    save: jest.fn((x: unknown) =>
      Array.isArray(x)
        ? Promise.resolve(x.map((i: object) => guardar(i)))
        : Promise.resolve(guardar(x as object)),
    ),
    update: jest.fn(
      (entidad: unknown, where: Record<string, unknown>, cambios: object) => {
        const filas =
          entidad === RouteBatch
            ? lotes
            : entidad === RouteBatchStop
              ? paradas
              : ofertas;
        return Promise.resolve({
          affected: aplicar(filas as object[], where, cambios),
        });
      },
    ),
    find: jest.fn(
      (entidad: unknown, opts: { where: Record<string, unknown> }) => {
        const filas =
          entidad === RouteBatch
            ? lotes
            : entidad === RouteBatchStop
              ? paradas
              : ofertas;
        return Promise.resolve(
          (filas as object[]).filter((f) => cumple(f, opts.where)),
        );
      },
    ),
    createQueryBuilder: jest.fn(() => {
      let id = '';
      const q = {
        setLock: () => q,
        where: (_s: string, p: { batchId: string }) => {
          id = p.batchId;
          return q;
        },
        getOneOrFail: () =>
          Promise.resolve(lotes.find((l) => l.batchId === id)),
      };
      return q;
    }),
  };

  const dataSource = {
    query,
    transaction: jest.fn(
      async (cb: (m: typeof manager) => Promise<unknown>) => {
        // Una transacción que falla deja el mundo como estaba.
        const foto = {
          lotes: lotes.map((l) => ({ ...l })),
          paradas: paradas.map((s) => ({ ...s })),
          ofertas: ofertas.map((o) => ({ ...o })),
        };
        try {
          return await cb(manager);
        } catch (error) {
          lotes.splice(0, lotes.length, ...foto.lotes);
          paradas.splice(0, paradas.length, ...foto.paradas);
          ofertas.splice(0, ofertas.length, ...foto.ofertas);
          throw error;
        }
      },
    ),
    getRepository: jest.fn(() => ({
      find: jest.fn((opts: { where: { orderId: FindOperator<string> } }) =>
        Promise.resolve(
          (opts.where.orderId.value as unknown as string[]).map((id) => ({
            orderId: id,
            status: pedidos.get(id)!.status,
            deliveryId: pedidos.get(id)!.deliveryId,
            paymentFraudHold:
              (pedidos.get(id) as { paymentFraudHold?: boolean })
                .paymentFraudHold === true,
          })),
        ),
      ),
    })),
  };

  const deliveryDe = (c: ChoferSim) => ({
    deliveryId: c.deliveryId,
    userId: c.userId,
    distributorId: c.distributorId,
    isEnabled: c.habilitado,
    validated: true,
    notificationToken: null,
    user: { fullName: `Chofer ${c.userId}` },
  });

  const deliveries = {
    buscarPorIdOUsuario: jest.fn((id: string) => {
      const c = choferes.find((x) => x.userId === id || x.deliveryId === id);
      return Promise.resolve(c ? deliveryDe(c) : null);
    }),
    findDeliveryIdsByUserIds: jest.fn((userIds: string[]) =>
      Promise.resolve(
        choferes
          .filter((c) => userIds.includes(c.userId))
          .map((c) => ({ userId: c.userId, deliveryId: c.deliveryId })),
      ),
    ),
    assertElegibleParaAsignacion: jest.fn((d: { isEnabled: boolean }) => {
      if (!d.isEnabled) throw new Error('El repartidor está deshabilitado');
    }),
  };

  const orchestrator = {
    choferesElegiblesCerca: jest.fn(() => Promise.resolve(elegibles)),
    ensureOffered: jest.fn((pedido: { orderId: string }) => {
      registro.devueltosAM1.push(pedido.orderId);
      return Promise.resolve();
    }),
  };

  const orderService = {
    findById: jest.fn((orderId: string) => {
      const p = pedidos.get(orderId);
      return Promise.resolve(
        p ? { orderId, status: p.status, deliveryId: p.deliveryId } : null,
      );
    }),
    // Doble fiel del real: sin `soloSiLibre` reasigna aunque el pedido ya tenga
    // chofer (ACCEPTED → ACCEPTED es una transición válida) y NO lanza.
    assignDelivery: jest.fn(
      (
        orderId: string,
        deliveryId: string,
        _distributorId?: string,
        opciones: { soloSiLibre?: boolean } = {},
      ) => {
        const falla = registro.asignacionesQueFallan.get(orderId);
        if (falla) return Promise.reject(falla);
        const p = pedidos.get(orderId)!;
        const libre = p.status === OrderStatus.PENDING && !p.deliveryId;
        const yaEsSuyo =
          p.status === OrderStatus.ACCEPTED && p.deliveryId === deliveryId;
        if (opciones.soloSiLibre && !libre && !yaEsSuyo) {
          return Promise.reject(
            new ConflictException('El pedido ya no está disponible'),
          );
        }
        if (
          p.status !== OrderStatus.PENDING &&
          p.status !== OrderStatus.ACCEPTED
        ) {
          return Promise.reject(
            new ConflictException('Transición de pedido inválida'),
          );
        }
        p.status = OrderStatus.ACCEPTED;
        p.deliveryId = deliveryId;
        registro.asignaciones.push({ orderId, deliveryId });
        return Promise.resolve({ orderId });
      },
    ),
  };

  const fleet = {
    assertChoferHabilitado: jest.fn((userId: string) => {
      const c = choferes.find((x) => x.userId === userId);
      if (c && !c.habilitado)
        throw new Error('No se puede asignar: licencia vencida');
      return Promise.resolve();
    }),
    vehiculoEnUsoDelChofer: jest.fn((userId: string) =>
      Promise.resolve({ carId: `car-${userId}` }),
    ),
  };

  const cars = {
    findOne: jest.fn((carId: string) => {
      const c = choferes.find((x) => `car-${x.userId}` === carId);
      return Promise.resolve({ carCapacity: c?.capacidadKg ?? null });
    }),
  };

  const withLock = jest.fn(
    async (
      _k: string,
      _t: number,
      fn: () => Promise<unknown>,
    ): Promise<{ obtenido: boolean; valor?: unknown }> => ({
      obtenido: true,
      valor: await fn(),
    }),
  );
  const redis = { withLock };

  const notifier = {
    ofertaAlChofer: jest.fn(
      (delivery: { deliveryId: string }, o: { batchId: string }) => {
        registro.ofertasAvisadas.push({
          deliveryId: delivery.deliveryId,
          batchId: o.batchId,
        });
        return Promise.resolve();
      },
    ),
    ofertaCerrada: jest.fn((userId: string, _b: string, motivo: string) => {
      registro.ofertasCerradas.push({ userId, motivo });
    }),
    loteAsignado: jest.fn((_u: string, _b: string, ids: string[]) => {
      registro.ultimoAvisoDeAsignacion.push(ids);
    }),
    loteSinChofer: jest.fn((_d: string, batchId: string) => {
      registro.lotesSinChofer.push(batchId);
    }),
  };

  const processConfig = {
    obtener: jest.fn(() => Promise.resolve(parametros)),
    vigentes: jest.fn(),
    guardar: jest.fn(),
  };

  const service = new RouteBatchService(
    dataSource as never,
    batches as never,
    stops as never,
    offers as never,
    processConfig as never,
    orchestrator as never,
    orderService as never,
    deliveries as never,
    fleet as never,
    cars as never,
    redis as never,
    notifier as never,
  );

  return {
    service,
    /** Una pasada que sí consiguió el cerrojo. */
    evaluar: async (id: string, ahora: Date) => {
      const r = await service.evaluar(id, ahora);
      if (!r) throw new Error('no se consiguió el cerrojo');
      return r;
    },
    parametros,
    pedidos,
    choferes,
    lotes,
    paradas,
    ofertas,
    registro,
    mocks: {
      dataSource,
      orchestrator,
      orderService,
      notifier,
      redis,
      processConfig,
      manager,
    },
    ponerElegibles: (ids: string[]) => {
      elegibles = ids;
    },
    fijarAhora: (d: Date) => {
      ahoraDelTest = d;
    },
  };
}

const chofer = (n: number, over: Partial<ChoferSim> = {}): ChoferSim => ({
  userId: `u${n}`,
  deliveryId: `dl${n}`,
  distributorId: D1,
  capacidadKg: null,
  habilitado: true,
  ...over,
});

const ahora = new Date('2026-11-01T12:00:00Z');

// El servicio compara vencimientos con el reloj real (`new Date()`): se fija el
// reloj del test en `ahora` para que las ofertas no venzan según el día en que corre.
beforeEach(() => {
  jest.useFakeTimers({
    now: ahora,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'queueMicrotask',
    ],
  });
});
afterEach(() => {
  jest.useRealTimers();
});

/** Dos pedidos cercanos de la misma franja y dos choferes, listo para armar. */
const escenarioBase = () =>
  crearMundo({
    pedidos: [
      pedidoSim('p1', { pesoKg: 10 }),
      pedidoSim('p2', { pesoKg: 15, lat: -27.382, lng: -55.935 }),
    ],
    choferes: [chofer(1), chofer(2)],
  });

describe('RouteBatchService · armado (CU-107, pasos 2 a 7)', () => {
  it('agrupa dos pedidos cercanos en un lote y se lo ofrece al chofer más cercano', async () => {
    const m = escenarioBase();

    const r = await m.evaluar(D1, ahora);

    expect(r).toEqual({ candidates: 2, batches: 1, orders: 2 });
    expect(m.lotes).toHaveLength(1);
    expect(m.lotes[0]).toMatchObject({
      distributorId: D1,
      status: RouteBatchStatus.OFFERED,
      totalWeightKg: 25,
    });
    expect(m.paradas.map((s) => [s.orderId, s.sequence, s.active])).toEqual([
      ['p1', 1, true],
      ['p2', 2, true],
    ]);
    expect(m.ofertas).toHaveLength(1);
    expect(m.ofertas[0]).toMatchObject({
      deliveryId: 'dl1',
      status: ProposalStatus.PENDING,
    });
    // La vigencia sale del parámetro de la distribuidora (60 s).
    expect(m.ofertas[0].expiresAt.getTime()).toBe(ahora.getTime() + 60_000);
    expect(m.registro.ofertasAvisadas).toEqual([
      { deliveryId: 'dl1', batchId: m.lotes[0].batchId },
    ]);
  });

  it('no arma lote si hay un solo pedido candidato', async () => {
    const m = crearMundo({ pedidos: [pedidoSim('p1')], choferes: [chofer(1)] });

    expect(await m.evaluar(D1, ahora)).toEqual({
      candidates: 1,
      batches: 0,
      orders: 0,
    });
    expect(m.lotes).toHaveLength(0);
  });

  it('no agrupa pedidos que están más lejos que el radio', async () => {
    const m = crearMundo({
      pedidos: [pedidoSim('p1'), pedidoSim('p2', { lat: -27.3, lng: -55.93 })],
      choferes: [chofer(1)],
    });

    const r = await m.evaluar(D1, ahora);

    expect(r.batches).toBe(0);
    expect(m.lotes).toHaveLength(0);
  });

  it('no agrupa franjas que difieren más que la tolerancia', async () => {
    const m = crearMundo({
      pedidos: [
        pedidoSim('p1'),
        pedidoSim('p2', {
          slotStartMs: OCHO + 4 * HORA,
          slotEndMs: OCHO + 8 * HORA,
        }),
      ],
      choferes: [chofer(1)],
    });

    expect((await m.evaluar(D1, ahora)).batches).toBe(0);
  });

  it('sin choferes habilitados cerca no se arma nada y los pedidos quedan para M1', async () => {
    const m = escenarioBase();
    m.ponerElegibles([]);

    const r = await m.evaluar(D1, ahora);

    expect(r.batches).toBe(0);
    expect(m.lotes).toHaveLength(0);
    expect(m.mocks.orchestrator.ensureOffered).not.toHaveBeenCalled();
  });

  it('el tamaño máximo corta el lote y el resto arma otro', async () => {
    const m = crearMundo({
      pedidos: ['p1', 'p2', 'p3', 'p4'].map((id) => pedidoSim(id)),
      choferes: [chofer(1), chofer(2)],
      parametros: { maxBatchSize: 2 },
    });

    const r = await m.evaluar(D1, ahora);

    expect(r).toEqual({ candidates: 4, batches: 2, orders: 4 });
    expect(
      m.lotes.map(
        (l) => m.paradas.filter((s) => s.batchId === l.batchId).length,
      ),
    ).toEqual([2, 2]);
    // Cada lote a un chofer distinto: el primero ya está ocupado con la oferta del otro.
    expect(m.ofertas.map((o) => o.deliveryId).sort()).toEqual(['dl1', 'dl2']);
  });

  it('la capacidad del vehículo manda: salta al chofer cuyo vehículo no carga el lote', async () => {
    const m = crearMundo({
      pedidos: [
        pedidoSim('p1', { pesoKg: 40 }),
        pedidoSim('p2', { pesoKg: 40 }),
      ],
      choferes: [
        chofer(1, { capacidadKg: 50 }),
        chofer(2, { capacidadKg: 100 }),
      ],
    });

    const r = await m.evaluar(D1, ahora);

    expect(r.batches).toBe(1);
    expect(m.ofertas[0].deliveryId).toBe('dl2');
    expect(m.lotes[0].totalWeightKg).toBe(80);
  });

  it('si ningún vehículo carga dos pedidos, no se arma el lote', async () => {
    const m = crearMundo({
      pedidos: [
        pedidoSim('p1', { pesoKg: 40 }),
        pedidoSim('p2', { pesoKg: 40 }),
      ],
      choferes: [chofer(1, { capacidadKg: 50 })],
    });

    expect((await m.evaluar(D1, ahora)).batches).toBe(0);
  });

  it('no toma el pedido que M1 le está ofreciendo a un chofer', async () => {
    const m = crearMundo({
      pedidos: [pedidoSim('p1', { ofertaDeM1: true }), pedidoSim('p2')],
      choferes: [chofer(1)],
    });

    const r = await m.evaluar(D1, ahora);

    expect(r.candidates).toBe(1);
    expect(m.lotes).toHaveLength(0);
  });

  it('si entre la lectura y la escritura un pedido deja de estar libre, no arma el lote', async () => {
    const m = escenarioBase();
    // Lo asignan a mano justo después de leer los candidatos.
    m.mocks.dataSource.transaction.mockImplementationOnce(async (cb) => {
      m.pedidos.get('p2')!.status = OrderStatus.CANCELLED;
      return cb(m.mocks.manager);
    });

    const r = await m.evaluar(D1, ahora);

    expect(r.batches).toBe(0);
    expect(m.lotes).toHaveLength(0);
    expect(m.ofertas).toHaveLength(0);
  });

  it('es idempotente: una segunda pasada no vuelve a armar un lote con los mismos pedidos', async () => {
    const m = escenarioBase();

    await m.evaluar(D1, ahora);
    const segunda = await m.evaluar(D1, ahora);

    expect(segunda.batches).toBe(0);
    expect(m.lotes).toHaveLength(1);
    expect(m.ofertas).toHaveLength(1);
  });

  it('si otra instancia tiene el cerrojo de la distribuidora, no hace nada y avisa con null', async () => {
    const m = escenarioBase();
    m.mocks.redis.withLock.mockResolvedValueOnce({ obtenido: false } as never);

    expect(await m.service.evaluar(D1, ahora)).toBeNull();
    expect(m.lotes).toHaveLength(0);
  });

  it('«armar ahora» con el cerrojo tomado responde 409 en vez de decir que no hubo candidatos', async () => {
    const m = escenarioBase();
    m.mocks.redis.withLock.mockResolvedValueOnce({ obtenido: false } as never);

    await expect(m.service.armarAhora(D1)).rejects.toThrow(ConflictException);
  });

  it('al armar un lote toma el mismo cerrojo por pedido que usa M1 para ofrecerlo (carrera cerrada)', async () => {
    const m = escenarioBase();

    await m.evaluar(D1, ahora);

    const claves = m.mocks.redis.withLock.mock.calls.map((c) => c[0]);
    expect(claves).toEqual(
      expect.arrayContaining(['dispatch:offer:p1', 'dispatch:offer:p2']),
    );
  });

  it('si otro proceso tiene el cerrojo de uno de los pedidos (M1 ofreciéndolo), no se arma el lote', async () => {
    const m = escenarioBase();
    m.mocks.redis.withLock.mockImplementation(
      async (k: string, _t: number, fn: () => Promise<unknown>) =>
        k === 'dispatch:offer:p2'
          ? { obtenido: false as const }
          : { obtenido: true as const, valor: await fn() },
    );

    const r = await m.evaluar(D1, ahora);

    expect(r.batches).toBe(0);
    expect(m.lotes).toHaveLength(0);
  });

  it('un pedido nunca queda en dos lotes vivos: un índice único lo rechaza y no se arma', async () => {
    const m = escenarioBase();
    m.mocks.dataSource.transaction.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    expect((await m.evaluar(D1, ahora)).batches).toBe(0);
  });

  it('un error de la base que no es de unicidad se propaga', async () => {
    const m = escenarioBase();
    m.mocks.dataSource.transaction.mockRejectedValueOnce(new Error('se cayó'));

    await expect(m.evaluar(D1, ahora)).rejects.toThrow('se cayó');
  });
});

describe('RouteBatchService · aceptar (paso 8)', () => {
  const conLoteOfrecido = async () => {
    const m = escenarioBase();
    await m.evaluar(D1, ahora);
    return { m, batchId: m.lotes[0].batchId };
  };

  it('asigna todos los pedidos al chofer, en el orden del recorrido, y deja el lote asignado', async () => {
    const { m, batchId } = await conLoteOfrecido();

    const r = await m.service.aceptar('u1', batchId);

    expect(r).toEqual({ batchId, accepted: true, assignedOrders: 2 });
    expect(m.registro.asignaciones).toEqual([
      { orderId: 'p1', deliveryId: 'dl1' },
      { orderId: 'p2', deliveryId: 'dl1' },
    ]);
    expect(m.lotes[0]).toMatchObject({
      status: RouteBatchStatus.ASSIGNED,
      deliveryId: 'dl1',
    });
    expect(m.ofertas[0].status).toBe(ProposalStatus.ACCEPTED);
    expect(m.ofertas[0].respondedAt).toBeInstanceOf(Date);
    expect(m.registro.ultimoAvisoDeAsignacion).toEqual([['p1', 'p2']]);
  });

  it('aceptar dos veces no asigna dos veces (idempotente)', async () => {
    const { m, batchId } = await conLoteOfrecido();

    await m.service.aceptar('u1', batchId);
    const otra = await m.service.aceptar('u1', batchId);

    expect(otra).toEqual({ batchId, accepted: true, assignedOrders: 2 });
    expect(m.mocks.orderService.assignDelivery).toHaveBeenCalledTimes(2);
  });

  it('un chofer que no tiene la oferta no puede aceptar (409) y no se asigna nada', async () => {
    const { m, batchId } = await conLoteOfrecido();

    await expect(m.service.aceptar('u2', batchId)).rejects.toThrow(
      new ConflictException('Esta oferta de lote ya no está vigente'),
    );
    expect(m.mocks.orderService.assignDelivery).not.toHaveBeenCalled();
  });

  it('una oferta vencida no se puede aceptar', async () => {
    const { m, batchId } = await conLoteOfrecido();
    m.ofertas[0].expiresAt = new Date(Date.now() - 1000);

    await expect(m.service.aceptar('u1', batchId)).rejects.toThrow(
      new ConflictException('La oferta del lote venció'),
    );
    expect(m.mocks.orderService.assignDelivery).not.toHaveBeenCalled();
    expect(m.lotes[0].status).toBe(RouteBatchStatus.OFFERED);
  });

  it('un lote de otra distribuidora es un 404', async () => {
    const { m, batchId } = await conLoteOfrecido();
    m.lotes[0].distributorId = 'otra';

    await expect(m.service.aceptar('u1', batchId)).rejects.toThrow(
      new NotFoundException('Lote no encontrado'),
    );
  });

  it('quien no es chofer no puede responder', async () => {
    const { m, batchId } = await conLoteOfrecido();

    await expect(m.service.aceptar('nadie', batchId)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('un chofer deshabilitado o con algo vencido no acepta y la oferta queda como estaba', async () => {
    const { m, batchId } = await conLoteOfrecido();
    m.choferes[0].habilitado = false;

    await expect(m.service.aceptar('u1', batchId)).rejects.toThrow(
      'El repartidor está deshabilitado',
    );
    expect(m.mocks.orderService.assignDelivery).not.toHaveBeenCalled();
    expect(m.ofertas[0].status).toBe(ProposalStatus.PENDING);
    expect(m.lotes[0].status).toBe(RouteBatchStatus.OFFERED);
  });

  it('no le roba el pedido a otro chofer: si ya lo tomó del pool o un admin, sale del lote y no cambia de dueño', async () => {
    const { m, batchId } = await conLoteOfrecido();
    m.pedidos.get('p2')!.status = OrderStatus.ACCEPTED;
    m.pedidos.get('p2')!.deliveryId = 'dl-otro';

    const r = await m.service.aceptar('u1', batchId);

    expect(r.assignedOrders).toBe(1);
    expect(m.pedidos.get('p2')!.deliveryId).toBe('dl-otro');
    expect(m.registro.asignaciones.map((a) => a.orderId)).toEqual(['p1']);
    expect(m.paradas.find((s) => s.orderId === 'p2')!.active).toBe(false);
  });

  it('vuelve a medir la capacidad del vehículo al aceptar: si ya no carga el lote, 409 y la oferta sigue', async () => {
    const { m, batchId } = await conLoteOfrecido();
    m.choferes[0].capacidadKg = 10;

    await expect(m.service.aceptar('u1', batchId)).rejects.toThrow(
      new ConflictException('El vehículo en uso no carga el peso del lote'),
    );
    expect(m.mocks.orderService.assignDelivery).not.toHaveBeenCalled();
    expect(m.ofertas[0].status).toBe(ProposalStatus.PENDING);
  });

  it('un pedido cancelado mientras tanto sale del lote y no frena a los demás', async () => {
    const m = crearMundo({
      pedidos: ['p1', 'p2', 'p3'].map((id, i) =>
        pedidoSim(id, { pesoKg: 10 + i, lat: -27.38 - i * 0.001 }),
      ),
      choferes: [chofer(1)],
    });
    await m.evaluar(D1, ahora);
    const batchId = m.lotes[0].batchId;
    m.pedidos.get('p2')!.status = OrderStatus.CANCELLED;

    const r = await m.service.aceptar('u1', batchId);

    expect(r.assignedOrders).toBe(2);
    expect(m.registro.asignaciones.map((a) => a.orderId)).toEqual(['p1', 'p3']);
    expect(m.paradas.find((s) => s.orderId === 'p2')!.active).toBe(false);
    expect(m.lotes[0].status).toBe(RouteBatchStatus.ASSIGNED);
  });

  it('M-2: ni los candidatos ni las paradas vivas incluyen pedidos retenidos por fraude (guarda sobre el código: el mundo simulado no ejecuta el SQL)', () => {
    const fuente = readFileSync(
      join(__dirname, 'route-batch.service.ts'),
      'utf8',
    );
    expect(fuente).toContain('AND NOT o."payment_fraud_hold"');
    // Y las paradas de un lote vivo de un pedido retenido salen del lote.
    expect(fuente).toContain('!p.paymentFraudHold');
    expect(fuente).toContain('!pedido.paymentFraudHold');
  });

  it('si ningún pedido sigue disponible el lote se deshace y responde 409', async () => {
    const { m, batchId } = await conLoteOfrecido();
    m.pedidos.get('p1')!.status = OrderStatus.CANCELLED;
    m.pedidos.get('p2')!.status = OrderStatus.CANCELLED;

    await expect(m.service.aceptar('u1', batchId)).rejects.toThrow(
      new ConflictException('Los pedidos del lote ya no están disponibles'),
    );
    expect(m.lotes[0]).toMatchObject({
      status: RouteBatchStatus.DISSOLVED,
      closeReason: RouteBatchCloseReason.ORDERS_UNAVAILABLE,
    });
    expect(m.paradas.every((s) => !s.active)).toBe(true);
  });

  it('un error del chofer en la primera parada (el pedido sigue libre) se propaga y no cierra la oferta', async () => {
    const { m, batchId } = await conLoteOfrecido();
    const fallo = new ConflictException('El chofer no tiene carga abierta');
    m.registro.asignacionesQueFallan.set('p1', fallo);

    await expect(m.service.aceptar('u1', batchId)).rejects.toBe(fallo);
    expect(m.ofertas[0].status).toBe(ProposalStatus.PENDING);
    expect(m.lotes[0].status).toBe(RouteBatchStatus.OFFERED);
    expect(m.registro.asignaciones).toHaveLength(0);
  });

  it('el pedido que falla a mitad del recorrido vuelve al despacho individual', async () => {
    const { m, batchId } = await conLoteOfrecido();
    m.registro.asignacionesQueFallan.set('p2', new Error('boom'));

    const r = await m.service.aceptar('u1', batchId);

    expect(r.assignedOrders).toBe(1);
    expect(m.registro.devueltosAM1).toEqual(['p2']);
    expect(m.paradas.find((s) => s.orderId === 'p2')!.active).toBe(false);
  });
});

describe('RouteBatchService · rechazar y vencer (pasos 9 a 11)', () => {
  const conLoteOfrecido = async (choferes: ChoferSim[]) => {
    const m = crearMundo({
      pedidos: [
        pedidoSim('p1'),
        pedidoSim('p2', { lat: -27.382, lng: -55.935 }),
      ],
      choferes,
    });
    await m.evaluar(D1, ahora);
    return { m, batchId: m.lotes[0].batchId };
  };

  it('al rechazar, cierra la oferta y se la ofrece de inmediato al siguiente chofer', async () => {
    const { m, batchId } = await conLoteOfrecido([chofer(1), chofer(2)]);

    const r = await m.service.rechazar('u1', batchId);

    expect(r).toEqual({ batchId, accepted: false, assignedOrders: 0 });
    expect(m.ofertas.map((o) => [o.deliveryId, o.status])).toEqual([
      ['dl1', ProposalStatus.REJECTED],
      ['dl2', ProposalStatus.PENDING],
    ]);
    expect(m.lotes[0].status).toBe(RouteBatchStatus.OFFERED);
    expect(m.registro.ofertasAvisadas.map((o) => o.deliveryId)).toEqual([
      'dl1',
      'dl2',
    ]);
  });

  it('no le vuelve a ofrecer el lote a quien ya lo rechazó', async () => {
    const { m, batchId } = await conLoteOfrecido([chofer(1), chofer(2)]);

    await m.service.rechazar('u1', batchId);
    await m.service.rechazar('u2', batchId);

    expect(m.ofertas.map((o) => o.deliveryId)).toEqual(['dl1', 'dl2']);
  });

  it('agotados los choferes, el lote se deshace y los pedidos vuelven al despacho individual', async () => {
    const { m, batchId } = await conLoteOfrecido([chofer(1)]);

    await m.service.rechazar('u1', batchId);

    expect(m.lotes[0]).toMatchObject({
      status: RouteBatchStatus.DISSOLVED,
      closeReason: RouteBatchCloseReason.EXHAUSTED,
    });
    expect(m.lotes[0].closedAt).toBeInstanceOf(Date);
    expect(m.paradas.every((s) => !s.active)).toBe(true);
    expect(m.registro.devueltosAM1.sort()).toEqual(['p1', 'p2']);
    expect(m.registro.lotesSinChofer).toEqual([batchId]);
  });

  it('un lote agotado no se vuelve a armar cada minuto: sus pedidos esperan a que los tome M1', async () => {
    const { m } = await conLoteOfrecido([chofer(1)]);
    await m.service.rechazar('u1', m.lotes[0].batchId);

    const r = await m.evaluar(D1, ahora);

    expect(r).toEqual({ candidates: 0, batches: 0, orders: 0 });
    expect(m.lotes).toHaveLength(1);
    // Un solo aviso al administrador por esos pedidos, no uno por vuelta.
    expect(m.registro.lotesSinChofer).toHaveLength(1);
  });

  it('un lote que deshizo un administrador tampoco vuelve a armarse solo', async () => {
    const { m } = await conLoteOfrecido([chofer(1), chofer(2)]);
    await m.service.deshacerPorAdmin(D1, m.lotes[0].batchId);

    expect((await m.evaluar(D1, ahora)).candidates).toBe(0);
  });

  it('un pedido que quedó solo por cancelación (orders_unavailable) sí puede entrar a otro lote', async () => {
    const { m } = await conLoteOfrecido([chofer(1), chofer(2)]);
    m.pedidos.get('p2')!.status = OrderStatus.CANCELLED;
    await m.service.rechazar('u1', m.lotes[0].batchId);

    expect((await m.evaluar(D1, ahora)).candidates).toBe(1);
  });

  it('el siguiente chofer tiene que poder cargar el lote', async () => {
    const m = crearMundo({
      pedidos: [
        pedidoSim('p1', { pesoKg: 40 }),
        pedidoSim('p2', { pesoKg: 40, lat: -27.382, lng: -55.935 }),
      ],
      choferes: [
        chofer(1, { capacidadKg: 100 }),
        chofer(2, { capacidadKg: 50 }),
      ],
    });
    await m.evaluar(D1, ahora);

    await m.service.rechazar('u1', m.lotes[0].batchId);

    expect(m.lotes[0].closeReason).toBe(RouteBatchCloseReason.EXHAUSTED);
    expect(m.ofertas.map((o) => o.deliveryId)).toEqual(['dl1']);
  });

  it('un pedido que se canceló mientras el lote estaba ofrecido sale de él; con menos de dos se deshace', async () => {
    const { m, batchId } = await conLoteOfrecido([chofer(1), chofer(2)]);
    m.pedidos.get('p2')!.status = OrderStatus.CANCELLED;

    await m.service.rechazar('u1', batchId);

    expect(m.lotes[0].closeReason).toBe(
      RouteBatchCloseReason.ORDERS_UNAVAILABLE,
    );
    expect(m.registro.devueltosAM1).toEqual(['p1']);
    expect(m.ofertas).toHaveLength(1);
  });

  it('rechazar sin tener la oferta es 409', async () => {
    const { m, batchId } = await conLoteOfrecido([chofer(1), chofer(2)]);

    await expect(m.service.rechazar('u2', batchId)).rejects.toThrow(
      ConflictException,
    );
  });

  it('con el módulo apagado, al vencer la oferta el lote se deshace y vuelve a M1 en vez de buscar otro chofer', async () => {
    const { m } = await conLoteOfrecido([chofer(1), chofer(2)]);
    m.parametros.enabled = 0;
    const despues = new Date(ahora.getTime() + 61_000);
    m.fijarAhora(despues);

    await m.service.vencerOfertas(despues);

    expect(m.lotes[0]).toMatchObject({
      status: RouteBatchStatus.DISSOLVED,
      closeReason: RouteBatchCloseReason.ADMIN,
    });
    expect(m.ofertas).toHaveLength(1);
    expect(m.registro.devueltosAM1.sort()).toEqual(['p1', 'p2']);
  });

  it('al vencer la oferta pasa al siguiente chofer', async () => {
    const { m } = await conLoteOfrecido([chofer(1), chofer(2)]);
    const despues = new Date(ahora.getTime() + 61_000);
    m.fijarAhora(despues);

    const r = await m.service.vencerOfertas(despues);

    expect(r.expired).toBe(1);
    expect(m.ofertas.map((o) => [o.deliveryId, o.status])).toEqual([
      ['dl1', ProposalStatus.EXPIRED],
      ['dl2', ProposalStatus.PENDING],
    ]);
    expect(m.registro.ofertasCerradas).toEqual([
      { userId: 'u1', motivo: 'expired' },
    ]);
  });

  it('si vence la oferta del último chofer, el lote se deshace y vuelve a M1', async () => {
    const { m } = await conLoteOfrecido([chofer(1)]);
    const despues = new Date(ahora.getTime() + 61_000);
    m.fijarAhora(despues);

    await m.service.vencerOfertas(despues);

    expect(m.lotes[0].closeReason).toBe(RouteBatchCloseReason.EXHAUSTED);
    expect(m.registro.devueltosAM1.sort()).toEqual(['p1', 'p2']);
  });

  it('una oferta que todavía está vigente no se vence', async () => {
    const { m } = await conLoteOfrecido([chofer(1), chofer(2)]);
    m.fijarAhora(new Date(ahora.getTime() + 30_000));

    const r = await m.service.vencerOfertas(new Date(ahora.getTime() + 30_000));

    expect(r.expired).toBe(0);
    expect(m.ofertas[0].status).toBe(ProposalStatus.PENDING);
  });

  it('retoma un lote ofrecido que se quedó sin oferta viva', async () => {
    const { m } = await conLoteOfrecido([chofer(1), chofer(2)]);
    m.ofertas[0].status = ProposalStatus.REJECTED;
    m.ofertas[0].respondedAt = ahora;

    const r = await m.service.vencerOfertas(ahora);

    expect(r.rescued).toBe(1);
    expect(m.ofertas.at(-1)).toMatchObject({
      deliveryId: 'dl2',
      status: ProposalStatus.PENDING,
    });
  });

  it('completa el recorrido cuando todos sus pedidos se entregaron o cancelaron', async () => {
    const { m, batchId } = await conLoteOfrecido([chofer(1)]);
    await m.service.aceptar('u1', batchId);
    m.pedidos.get('p1')!.status = OrderStatus.DELIVERED;

    expect((await m.service.vencerOfertas(ahora)).completed).toBe(0);

    m.pedidos.get('p2')!.status = OrderStatus.CANCELLED;
    expect((await m.service.vencerOfertas(ahora)).completed).toBe(1);
    expect(m.lotes[0].status).toBe(RouteBatchStatus.COMPLETED);
    expect(m.paradas.every((s) => !s.active)).toBe(true);
  });
});

describe('RouteBatchService · interruptor del módulo', () => {
  it('apagado (el valor por omisión), «armar ahora» responde 409 y no toca nada', async () => {
    const m = crearMundo({
      pedidos: [pedidoSim('p1'), pedidoSim('p2')],
      choferes: [chofer(1)],
      parametros: { enabled: 0 },
    });

    await expect(m.service.armarAhora(D1)).rejects.toThrow(
      new ConflictException(
        'La agrupación por recorrido está apagada: encendela en los parámetros para armar lotes',
      ),
    );
    expect(m.lotes).toHaveLength(0);
    expect(m.mocks.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('encendido, «armar ahora» arma los lotes', async () => {
    const m = escenarioBase();

    expect(await m.service.armarAhora(D1)).toMatchObject({
      batches: 1,
      orders: 2,
    });
    expect(await m.service.estaEncendido(D1)).toBe(true);
  });
});

describe('RouteBatchService · administrador y parámetros', () => {
  it('el administrador deshace un lote sin chofer: cierra la oferta y devuelve los pedidos a M1', async () => {
    const m = escenarioBase();
    await m.evaluar(D1, ahora);
    const batchId = m.lotes[0].batchId;

    await m.service.deshacerPorAdmin(D1, batchId);

    expect(m.lotes[0]).toMatchObject({
      status: RouteBatchStatus.DISSOLVED,
      closeReason: RouteBatchCloseReason.ADMIN,
    });
    expect(m.ofertas[0].status).toBe(ProposalStatus.EXPIRED);
    expect(m.registro.ofertasCerradas).toEqual([
      { userId: 'u1', motivo: 'dissolved' },
    ]);
    expect(m.registro.devueltosAM1.sort()).toEqual(['p1', 'p2']);
  });

  it('no deshace un lote que ya tiene chofer', async () => {
    const m = escenarioBase();
    await m.evaluar(D1, ahora);
    const batchId = m.lotes[0].batchId;
    await m.service.aceptar('u1', batchId);

    await expect(m.service.deshacerPorAdmin(D1, batchId)).rejects.toThrow(
      ConflictException,
    );
    expect(m.lotes[0].status).toBe(RouteBatchStatus.ASSIGNED);
  });

  it('un administrador de otra distribuidora no ve ni deshace el lote (404)', async () => {
    const m = escenarioBase();
    await m.evaluar(D1, ahora);

    await expect(
      m.service.deshacerPorAdmin('otra', m.lotes[0].batchId),
    ).rejects.toThrow(NotFoundException);
    expect(m.lotes[0].status).toBe(RouteBatchStatus.OFFERED);
  });

  it('cambiar parámetros guarda sólo lo que viene y conserva el resto', async () => {
    const m = escenarioBase();
    m.mocks.processConfig.guardar.mockResolvedValue({ ok: true });

    await m.service.cambiarParametros(
      D1,
      { groupingRadiusKm: 5, maxBatchSize: undefined },
      'admin-1',
    );

    expect(m.mocks.processConfig.guardar).toHaveBeenCalledWith(
      D1,
      'route_batching',
      expect.objectContaining({
        groupingRadiusKm: 5,
        maxBatchSize: 4,
        offerTtlSeconds: 60,
      }),
      'admin-1',
    );
  });

  it('las distribuidoras que mira el proceso son las que tienen programados sin chofer', async () => {
    const m = escenarioBase();

    expect(await m.service.distribuidorasConProgramados()).toEqual([D1]);
  });
});
