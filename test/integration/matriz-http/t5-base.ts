/**
 * Escenario T5 (entregas, rendiciones, recorridos y carga del camión): sobre la
 * base de la T2 agrega stock por el libro, cajas, categorías de gasto y fábricas
 * que dejan una carga, una rendición o un lote en el estado que pide cada caso.
 * Cada fábrica usa un chofer nuevo: una carga abierta bloquea a su chofer y a su
 * camión, así los casos no dependen unos de otros.
 */
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { Car, FleetStatus } from '../../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../../src/car/entities/vehicle-assignment.entity';
import {
  CashBoxKind,
  CategoryDirection,
} from '../../../src/cash/domain/cash.enums';
import { CashBox } from '../../../src/cash/entities/cash-box.entity';
import { CashCategory } from '../../../src/cash/entities/cash-category.entity';
import { ProposalStatus } from '../../../src/common/enums/proposal-status.enum';
import { diaArgentino } from '../../../src/common/utils/dias-argentina';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Delivery } from '../../../src/delivery/entities/delivery.entity';
import { EmployeeService } from '../../../src/employee/employee.service';
import {
  MaintenanceCriticality,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from '../../../src/fleet/entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from '../../../src/fleet/entities/maintenance-task.entity';
import { GasCylinder } from '../../../src/gascylinder/entities/gascylinder.entity';
import { Order, OrderStatus } from '../../../src/order/entities/order.entity';
import { RouteBatchOffer } from '../../../src/order/entities/route-batch-offer.entity';
import { RouteBatchStop } from '../../../src/order/entities/route-batch-stop.entity';
import {
  RouteBatch,
  RouteBatchCloseReason,
  RouteBatchStatus,
} from '../../../src/order/entities/route-batch.entity';
import { WarehouseService } from '../../../src/stock/application/warehouse.service';
import { StockLedgerPort } from '../../../src/stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../../src/stock/domain/stock.enums';
import { Warehouse } from '../../../src/stock/entities/warehouse.entity';
import { conBypassManager } from '../setup/bypass';
import { fechasSegunEstado } from '../setup/pedido-valido';
import { entregarComoAdmin } from '../setup/entrega-admin';
import { TestEnv, patenteDePrueba } from '../setup/test-env';
import {
  Cabeceras,
  Caso,
  Persona,
  endpoint,
  llamar,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
  sembrarPersona,
} from './matriz';
import { EscenarioT2, sembrarBaseT2, sembrarPedido } from './t2-base';

export interface ChoferT5 extends Persona {
  deliveryId: string;
  carId: string;
  cabeceras: Cabeceras;
}

export interface EscenarioT5 extends EscenarioT2 {
  env: TestEnv;
  depositoA: string;
  depositoB: string;
  /** Depósito inactivo de la A. */
  depositoInactivo: string;
  /** Garrafa de la A sin una sola unidad en el libro. */
  garrafaSinStock: string;
  /** Caja sin sesión de la A y de la B. */
  cajaA: string;
  cajaB: string;
  /** Caja de la A que exige sesión y no la tiene abierta. */
  cajaConSesion: string;
  /** Caja desactivada de la A. */
  cajaInactiva: string;
  gastoA: string;
  gastoB: string;
  gastoInactivo: string;
  ingresoA: string;
  /** Vehículo de cada distribuidora, sin asignar. */
  autoA: string;
  autoB: string;
  /** El chofer y demás personas que preparó el caso, por clave. */
  ch: Record<string, ChoferT5>;
  /** Copias de filas para comprobar que nada cambió. */
  foto: Record<string, string>;
}

const STOCK_INICIAL = 2000;

async function asentarStock(
  env: TestEnv,
  distributorId: string,
  locationId: string,
  gasCylinderId: string,
  llenas: number,
  vacias: number,
): Promise<void> {
  const ds = env.app.get(DataSource);
  const ledger = env.app.get(StockLedgerPort);
  await ds.transaction(async (manager) => {
    const base = {
      distributorId,
      referenceType: StockReferenceType.INITIAL,
      referenceId: null,
      actorUserId: null,
    };
    await ledger.aplicar(manager, {
      ...base,
      movimientos: [
        {
          gasCylinderId,
          quantity: llenas,
          from: null,
          to: { locationId, condition: StockCondition.FULL },
          reason: StockMovementReason.INITIAL_COUNT,
        },
      ],
    });
    if (vacias > 0) {
      await ledger.aplicar(manager, {
        ...base,
        vendible: 'sin-cambio',
        movimientos: [
          {
            gasCylinderId,
            quantity: vacias,
            from: null,
            to: { locationId, condition: StockCondition.EMPTY },
            reason: StockMovementReason.INITIAL_COUNT,
          },
        ],
      });
    }
  });
}

export async function sembrarBaseT5(env: TestEnv): Promise<EscenarioT5> {
  const app = env.app;
  const base = await sembrarBaseT2(app, await sembrarEscenario(app));
  const ds = app.get(DataSource);
  const almacenes = app.get(WarehouseService);
  const depA = await almacenes.asegurarPredeterminado(base.distA.id);
  const depB = await almacenes.asegurarPredeterminado(base.distB.id);
  for (const [dist, loc, gas] of [
    [base.distA.id, depA.locationId, base.garrafaA],
    [base.distA.id, depA.locationId, base.garrafaA2],
    [base.distB.id, depB.locationId, base.garrafaB],
  ]) {
    await asentarStock(env, dist, loc, gas, STOCK_INICIAL, STOCK_INICIAL);
  }
  const garrafaSinStock = (
    await ds.getRepository(GasCylinder).save({
      type: '45kg',
      price: 1000,
      stock: 0,
      weight: 45,
      isActive: true,
      distributorId: base.distA.id,
    } as Partial<GasCylinder>)
  ).gasCylinderId;
  const inactivo = await ds.getRepository(Warehouse).save({
    distributorId: base.distA.id,
    name: 'Depósito inactivo',
    code: 'INACT1',
    isActive: false,
  } as Partial<Warehouse>);

  const caja = async (
    distributorId: string,
    name: string,
    requiresSession = false,
    isActive = true,
  ) =>
    (
      await ds.getRepository(CashBox).save({
        distributorId,
        name,
        kind: requiresSession ? CashBoxKind.CASH : CashBoxKind.BANK,
        requiresSession,
        isActive,
      } as Partial<CashBox>)
    ).cashBoxId;
  const categoria = async (
    distributorId: string,
    name: string,
    direction: CategoryDirection,
    isActive = true,
  ) =>
    (
      await ds.getRepository(CashCategory).save({
        distributorId,
        name,
        direction,
        isActive,
      } as Partial<CashCategory>)
    ).categoryId;
  const auto = async (distributorId: string, userId: string) =>
    (
      await ds.getRepository(Car).save({
        distributorId,
        userId,
        carPatent: patenteDePrueba(),
        typeCar: 'Camioneta',
      } as Partial<Car>)
    ).carId;

  return {
    ...base,
    env,
    reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    depositoA: depA.warehouse.warehouseId,
    depositoB: depB.warehouse.warehouseId,
    depositoInactivo: inactivo.warehouseId,
    garrafaSinStock,
    cajaA: await caja(base.distA.id, 'Banco A'),
    cajaB: await caja(base.distB.id, 'Banco B'),
    cajaConSesion: await caja(base.distA.id, 'Mostrador A', true),
    cajaInactiva: await caja(base.distA.id, 'Vieja A', false, false),
    gastoA: await categoria(base.distA.id, 'Nafta', CategoryDirection.EXPENSE),
    gastoB: await categoria(base.distB.id, 'Nafta', CategoryDirection.EXPENSE),
    gastoInactivo: await categoria(
      base.distA.id,
      'Peajes viejos',
      CategoryDirection.EXPENSE,
      false,
    ),
    ingresoA: await categoria(
      base.distA.id,
      'Ventas',
      CategoryDirection.INCOME,
    ),
    autoA: await auto(base.distA.id, base.choferA.userId),
    autoB: await auto(base.distB.id, base.choferB.userId),
    ch: {},
    foto: {},
  };
}

// --- Choferes y vehículos ---

export interface OpcionesChofer {
  dist?: 'A' | 'B';
  vehiculo?: boolean;
  capacidad?: number;
  /** Con legajo: lo exige descontar un faltante y la baja con rendición pendiente. */
  legajo?: boolean;
}

export async function nuevoChofer(
  c: EscenarioT5,
  o: OpcionesChofer = {},
): Promise<ChoferT5> {
  const ds = c.app.get(DataSource);
  const distributorId = o.dist === 'B' ? c.distB.id : c.distA.id;
  const persona = await sembrarPersona(
    c.app,
    'delivery',
    `t5-${randomUUID().slice(0, 6)}`,
    distributorId,
  );
  const [fila] = await ds.query<Array<{ delivery_id: string }>>(
    `SELECT delivery_id FROM delivery WHERE user_id = $1`,
    [persona.userId],
  );
  const carId = (
    await ds.getRepository(Car).save({
      distributorId,
      userId: persona.userId,
      carPatent: patenteDePrueba(),
      typeCar: 'Camioneta',
      ...(o.capacidad !== undefined ? { carCapacity: o.capacidad } : {}),
    } as Partial<Car>)
  ).carId;
  if (o.vehiculo !== false) {
    await ds.getRepository(VehicleAssignment).save({
      distributorId,
      carId,
      deliveryId: fila.delivery_id,
      assignedAt: new Date(),
    } as Partial<VehicleAssignment>);
  }
  if (o.legajo) {
    await ds.transaction((manager) =>
      c.app.get(EmployeeService).crearParaUsuario(manager, {
        userId: persona.userId,
        distributorId,
        rol: RoleType.DELIVERY,
        fullName: 'Chofer T5',
        phoneNumber: persona.phone,
      }),
    );
  }
  return { ...persona, deliveryId: fila.delivery_id, carId };
}

/** Un usuario con rol de chofer al que le falta el perfil de reparto. */
export async function choferSinPerfil(c: EscenarioT5): Promise<ChoferT5> {
  const chofer = await nuevoChofer(c, { vehiculo: false });
  await c.app
    .get(DataSource)
    .query(`DELETE FROM car WHERE car_id = $1`, [chofer.carId]);
  await c.app
    .get(DataSource)
    .query(`DELETE FROM delivery WHERE delivery_id = $1`, [chofer.deliveryId]);
  return chofer;
}

/** Deja al chofer deshabilitado o sin validar. */
export const marcarChofer = (
  c: EscenarioT5,
  deliveryId: string,
  datos: Partial<Delivery>,
) =>
  c.app.get(DataSource).getRepository(Delivery).update({ deliveryId }, datos);

/** Una tarea bloqueante vencida (licencia o VTV): inhabilita al sujeto. */
export async function vencerDocumento(
  c: EscenarioT5,
  sujeto: { carId: string } | { deliveryId: string },
  distributorId = c.distA.id,
): Promise<void> {
  const ds = c.app.get(DataSource);
  const plan = await ds.getRepository(MaintenancePlan).save({
    distributorId,
    name: `Doc ${randomUUID().slice(0, 6)}`,
    subject:
      'carId' in sujeto
        ? MaintenanceSubject.VEHICLE
        : MaintenanceSubject.DRIVER,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
  } as Partial<MaintenancePlan>);
  await ds.getRepository(MaintenanceTask).save({
    planId: plan.planId,
    distributorId,
    ...sujeto,
    status: MaintenanceTaskStatus.FORECAST,
    dueAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
  } as Partial<MaintenanceTask>);
}

export const dejarFueraDeServicio = (c: EscenarioT5, carId: string) =>
  c.app
    .get(DataSource)
    .getRepository(Car)
    .update({ carId }, { fleetStatus: FleetStatus.GROUNDED });

// --- Pedidos ---

/** Un pedido del cliente A puesto a nombre de este chofer, en el estado pedido. */
export async function pedidoDe(
  c: EscenarioT5,
  chofer: ChoferT5,
  estado: OrderStatus,
): Promise<{ orderId: string; total: number }> {
  const orderId = await sembrarPedido(c, { estado, chofer: 'A' });
  const ds = c.app.get(DataSource);
  await conBypassManager(ds, ['transiciones'], (m) =>
    m.update(
      Order,
      { orderId },
      { deliveryId: chofer.deliveryId, vehicleCarId: chofer.carId },
    ),
  );
  const fila = await ds.getRepository(Order).findOneByOrFail({ orderId });
  return { orderId, total: Number(fila.totalAmount) };
}

/** Entrega por el circuito real: mueve el stock del camión. */
export const entregar = (c: EscenarioT5, orderId: string) =>
  entregarComoAdmin(c.env, orderId);

// --- Cargas ---

export type EstadoCarga =
  | 'loading'
  | 'on_route'
  | 'returned'
  | 'closed'
  | 'closed_with_difference'
  | 'cancelled';

export interface OpcionesCarga {
  estado?: EstadoCarga;
  dist?: 'A' | 'B';
  chofer?: ChoferT5;
  llenas?: number;
}

const exigir2xx = (res: { status: number; body: unknown }, que: string) => {
  if (res.status >= 300) {
    throw new Error(
      `No se pudo ${que} (${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
};

/** Abre una carga por la API y la lleva al estado pedido por la API. */
export async function sembrarCarga(
  c: EscenarioT5,
  o: OpcionesCarga = {},
): Promise<{ loadId: string; chofer: ChoferT5 }> {
  const dist = o.dist ?? 'A';
  const admin = dist === 'B' ? 'adminB' : 'adminA';
  const gas = dist === 'B' ? c.garrafaB : c.garrafaA;
  const chofer = o.chofer ?? (await nuevoChofer(c, { dist }));
  const llenas = o.llenas ?? 5;
  const abierta = await llamar(c, 'post', '/truck-loads', admin, {
    carId: chofer.carId,
    deliveryId: chofer.deliveryId,
    items: [{ gasCylinderId: gas, loadedFull: llenas, loadedEmpty: 0 }],
  });
  exigir2xx(abierta, 'abrir la carga');
  const loadId = (abierta.body as { loadId: string }).loadId;
  const estado = o.estado ?? 'loading';
  const paso = async (accion: string, body?: object) =>
    exigir2xx(
      await llamar(c, 'patch', `/truck-loads/${loadId}/${accion}`, admin, body),
      `${accion} la carga`,
    );
  if (estado === 'cancelled') await paso('cancel', { reason: 'Prueba' });
  if (estado === 'loading' || estado === 'cancelled') {
    return { loadId, chofer };
  }
  await paso('depart');
  if (estado === 'on_route') return { loadId, chofer };
  const declaradas = estado === 'closed_with_difference' ? llenas - 1 : llenas;
  await paso('return', {
    items: [{ gasCylinderId: gas, declaredFull: declaradas, declaredEmpty: 0 }],
  });
  if (estado === 'returned') return { loadId, chofer };
  await paso('close', {
    ...(estado === 'closed_with_difference'
      ? { differenceNote: 'Faltó una' }
      : {}),
  });
  return { loadId, chofer };
}

/** Abre una carga con estos renglones y devuelve su id. */
export async function abrirCargaCon(
  c: EscenarioT5,
  chofer: ChoferT5,
  items: object[],
): Promise<string> {
  const res = await llamar(c, 'post', '/truck-loads', 'adminA', {
    carId: chofer.carId,
    deliveryId: chofer.deliveryId,
    items,
  });
  exigir2xx(res, 'abrir la carga');
  return (res.body as { loadId: string }).loadId;
}

/** Garrafas nuevas de la A con stock propio, para llegar al tope de renglones. */
export async function garrafasNuevas(
  c: EscenarioT5,
  cantidad: number,
): Promise<string[]> {
  const ds = c.app.get(DataSource);
  const locationId = (
    await c.app.get(WarehouseService).asegurarPredeterminado(c.distA.id)
  ).locationId;
  const ids: string[] = [];
  for (let i = 0; i < cantidad; i += 1) {
    const g = await ds.getRepository(GasCylinder).save({
      type: `tipo-${randomUUID().slice(0, 6)}`,
      price: 1000,
      stock: 0,
      weight: 10,
      isActive: true,
      distributorId: c.distA.id,
    } as Partial<GasCylinder>);
    await asentarStock(c.env, c.distA.id, locationId, g.gasCylinderId, 10, 0);
    ids.push(g.gasCylinderId);
  }
  return ids;
}

// --- Rendiciones ---

export type EstadoRendicion = 'open' | 'submitted' | 'approved';

export interface OpcionesRendicion {
  estado?: EstadoRendicion;
  dist?: 'A' | 'B';
  chofer?: ChoferT5;
  declarado?: number;
}

export const hoy = (): string => diaArgentino();

/** Abre una rendición por la API y la lleva al estado pedido. */
export async function sembrarRendicion(
  c: EscenarioT5,
  o: OpcionesRendicion = {},
): Promise<{ settlementId: string; chofer: ChoferT5 }> {
  const dist = o.dist ?? 'A';
  const admin = dist === 'B' ? 'adminB' : 'adminA';
  const chofer = o.chofer ?? (await nuevoChofer(c, { dist }));
  const abierta = await llamar(c, 'post', '/driver-settlements', admin, {
    deliveryId: chofer.deliveryId,
    businessDate: hoy(),
  });
  exigir2xx(abierta, 'abrir la rendición');
  const settlementId = (abierta.body as { settlementId: string }).settlementId;
  const estado = o.estado ?? 'open';
  if (estado === 'open') return { settlementId, chofer };
  const declarado = o.declarado ?? 0;
  exigir2xx(
    await llamar(
      c,
      'post',
      `/driver-settlements/${settlementId}/submit`,
      admin,
      { declaredCash: declarado },
    ),
    'presentar la rendición',
  );
  if (estado === 'submitted') return { settlementId, chofer };
  exigir2xx(
    await llamar(
      c,
      'patch',
      `/driver-settlements/${settlementId}/approve`,
      admin,
      {
        cashBoxId: dist === 'B' ? c.cajaB : c.cajaA,
        ...(declarado > 0 ? { differenceResolution: 'absorbed' } : {}),
      },
    ),
    'aprobar la rendición',
  );
  return { settlementId, chofer };
}

// --- Lotes de recorrido ---

export interface OpcionesLote {
  estado?: RouteBatchStatus;
  dist?: 'A' | 'B';
  /** A quién está ofrecido (oferta pendiente). */
  ofrecidoA?: ChoferT5;
  /** Chofer del lote asignado o completado. */
  chofer?: ChoferT5;
  /** Oferta ya vencida. */
  vencida?: boolean;
  peso?: number;
  /** Deja los pedidos cancelados (ya no disponibles). */
  pedidosCancelados?: boolean;
}

export async function sembrarLote(
  c: EscenarioT5,
  o: OpcionesLote = {},
): Promise<{ batchId: string; pedidos: string[] }> {
  const ds = c.app.get(DataSource);
  const deB = o.dist === 'B';
  const pedidos = [
    await sembrarPedido(c, { cliente: deB ? 'B' : 'A' }),
    await sembrarPedido(c, { cliente: deB ? 'B' : 'A' }),
  ];
  const estado = o.estado ?? RouteBatchStatus.OFFERED;
  const lote = await ds.getRepository(RouteBatch).save({
    distributorId: deB ? c.distB.id : c.distA.id,
    status: estado,
    totalWeightKg: o.peso ?? 20,
    ...(o.chofer ? { deliveryId: o.chofer.deliveryId } : {}),
    ...(estado === RouteBatchStatus.DISSOLVED ||
    estado === RouteBatchStatus.COMPLETED
      ? { closedAt: new Date() }
      : {}),
    ...(estado === RouteBatchStatus.DISSOLVED
      ? { closeReason: RouteBatchCloseReason.ADMIN }
      : {}),
  } as Partial<RouteBatch>);
  await ds.getRepository(RouteBatchStop).save(
    pedidos.map((orderId, i) => ({
      batchId: lote.batchId,
      orderId,
      sequence: i + 1,
    })) as Array<Partial<RouteBatchStop>>,
  );
  const ofertado = o.ofrecidoA ?? o.chofer;
  if (ofertado) {
    await ds.getRepository(RouteBatchOffer).save({
      batchId: lote.batchId,
      deliveryId: ofertado.deliveryId,
      status:
        o.ofrecidoA !== undefined
          ? ProposalStatus.PENDING
          : ProposalStatus.ACCEPTED,
      expiresAt: new Date(Date.now() + (o.vencida ? -3600 : 3600) * 1000),
      respondedAt: o.ofrecidoA !== undefined ? null : new Date(),
    } as Partial<RouteBatchOffer>);
  }
  if (o.pedidosCancelados) {
    for (const orderId of pedidos) {
      await ds.getRepository(Order).update(
        { orderId },
        {
          status: OrderStatus.CANCELLED,
          ...fechasSegunEstado(OrderStatus.CANCELLED),
        },
      );
    }
  }
  return { batchId: lote.batchId, pedidos };
}

/** Toma un cerrojo de Redlock a mano, como si otra instancia lo tuviera. */
export async function tomarCerrojo(env: TestEnv, clave: string): Promise<void> {
  const redis = new Redis({
    host: env.redisContainer.getHost(),
    port: env.redisContainer.getMappedPort(6379),
  });
  try {
    await redis.set(`lock:${clave}`, 'otro', 'PX', 30000);
  } finally {
    redis.disconnect();
  }
}

export async function soltarCerrojo(
  env: TestEnv,
  clave: string,
): Promise<void> {
  const redis = new Redis({
    host: env.redisContainer.getHost(),
    port: env.redisContainer.getMappedPort(6379),
  });
  try {
    await redis.del(`lock:${clave}`);
  } finally {
    redis.disconnect();
  }
}

// --- Aislamiento y bordes ---

/** Las filas tal como están, para comparar antes y después. */
export async function filas(
  c: EscenarioT5,
  tabla: string,
  columna: string,
  id: string,
): Promise<string> {
  const [fila] = await c.app.get(DataSource).query<Array<{ t: unknown }>>(
    `SELECT coalesce(json_agg(x ORDER BY md5(x::text)), '[]'::json) AS t
       FROM (SELECT * FROM "${tabla}" WHERE "${columna}" = $1) x`,
    [id],
  );
  return JSON.stringify(fila.t);
}

/**
 * Para las escrituras de otra distribuidora: prepara, copia la fila ajena y
 * después de la respuesta comprueba que sigue idéntica.
 */
export function sinCambios(
  tabla: string,
  columna: string,
  id: (c: EscenarioT5) => string,
  preparar?: (c: EscenarioT5) => Promise<void>,
): Pick<Caso<EscenarioT5>, 'antes' | 'verificar'> {
  return {
    antes: async (c) => {
      await preparar?.(c);
      c.foto[tabla] = await filas(c, tabla, columna, id(c));
    },
    verificar: async (_cuerpo, c) => {
      expect(await filas(c, tabla, columna, id(c))).toBe(c.foto[tabla]);
    },
  };
}

/** Como `sinCambios`, sobre varias tablas a la vez (referencias ajenas). */
export function sinCambiosEn(
  destinos: Array<{
    tabla: string;
    columna: string;
    id: (c: EscenarioT5) => string;
  }>,
  preparar?: (c: EscenarioT5) => Promise<void>,
): Pick<Caso<EscenarioT5>, 'antes' | 'verificar'> {
  return {
    antes: async (c) => {
      await preparar?.(c);
      for (const [i, d] of destinos.entries()) {
        c.foto[`multi${i}`] = await filas(c, d.tabla, d.columna, d.id(c));
      }
    },
    verificar: async (_cuerpo, c) => {
      for (const [i, d] of destinos.entries()) {
        expect(await filas(c, d.tabla, d.columna, d.id(c))).toBe(
          c.foto[`multi${i}`],
        );
      }
    },
  };
}

type Fila = ReturnType<typeof endpoint<EscenarioT5>>;

/** Los casos de acceso y de id que tiene toda ruta. */
export function bordes(
  ep: Fila,
  o: {
    /** Roles que tienen que recibir 403. */
    prohibidos: string[];
    body?: object;
    /** Ruta con un id mal formado. */
    idMalo?: string;
    idMaloActor?: string;
  },
): Array<Caso<EscenarioT5>> {
  return [
    ep('sin token', undefined, 401, { body: o.body }),
    ...o.prohibidos.map((actor) =>
      ep(`rol no permitido: ${actor}`, actor, 403, { body: o.body }),
    ),
    ...(o.idMalo
      ? [
          ep('id mal formado', o.idMaloActor ?? 'adminA', 400, {
            ruta: o.idMalo,
            body: o.body,
          }),
        ]
      : []),
  ];
}

export const SOLO_ADMIN = ['chofer', 'clienteA'];
export const ADMIN_O_CHOFER = ['clienteA'];
export const SOLO_CHOFER = ['adminA', 'super', 'clienteA'];

/** Cabeceras del chofer que armó el caso (`c.ch.c`). */
export const comoChofer = (c: EscenarioT5): Record<string, string> =>
  c.ch.c.cabeceras;
