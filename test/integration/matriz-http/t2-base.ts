/**
 * Escenario común de la T2 (pedidos, express, carrito, calificaciones): sobre
 * el de la T1 agrega zonas de cobertura, garrafas, direcciones, un segundo
 * chofer, un chofer de la otra distribuidora y una fábrica de pedidos en el
 * estado que pida cada caso.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Car } from '../../../src/car/entities/car.entity';
import { VehicleAssignment } from '../../../src/car/entities/vehicle-assignment.entity';
import { CoverageZone } from '../../../src/coverage-zone/entities/coverage-zone.entity';
import { GasCylinder } from '../../../src/gascylinder/entities/gascylinder.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../../src/order/entities/order.entity';
import { RealtimeDispatchPort } from '../../../src/order/domain/ports/realtime-dispatch.port';
import { UserAddress } from '../../../src/user-address/entities/user-address.entity';
import request from 'supertest';
import { Redis } from 'ioredis';
import { TestApp, TestEnv, patenteDePrueba } from '../setup/test-env';
import { fechasSegunEstado } from '../setup/pedido-valido';
import { conBypassManager } from '../setup/bypass';
import {
  Caso,
  ContextoMatriz,
  Escenario,
  Persona,
  cabecerasDe_,
  llamar,
  sembrarPersona,
} from './matriz';

export const ZONA_CENTRO = { lng: -58.38, lat: -34.6 };
export const ZONA_NORTE = { lng: -58.3, lat: -34.6 };
export const FUERA_DE_ZONA = { lng: -57.0, lat: -34.0 };

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

export interface EscenarioT2 extends Escenario {
  /** Garrafas con stock de sobra de A y de B. */
  garrafaA: string;
  garrafaA2: string;
  garrafaB: string;
  /** Direcciones del clienteA: en zona (10 %), en otra zona (25 %) y fuera de cobertura. */
  dirCentro: string;
  dirNorte: string;
  dirFuera: string;
  /** Dirección del clienteB (distribuidora B) y una de un tercero. */
  dirB: string;
  dirAjena: string;
  choferA2: Persona & { deliveryId: string };
  choferB: Persona & { deliveryId: string };
  /** Ids de pedidos de cada caso, por clave. */
  p: Record<string, string>;
}

async function direccion(
  ds: DataSource,
  userId: string,
  punto: { lng: number; lat: number },
  calle: string,
  porDefecto = false,
): Promise<string> {
  const d = await ds.getRepository(UserAddress).save({
    userId,
    street: calle,
    city: 'CABA',
    isDefault: porDefecto,
    location: { type: 'Point', coordinates: [punto.lng, punto.lat] },
  } as unknown as Partial<UserAddress>);
  return d.addressId;
}

export async function conVehiculo(
  ds: DataSource,
  distributorId: string,
  userId: string,
  deliveryId: string,
  tipo = 'Camioneta',
): Promise<void> {
  const auto = (await ds.getRepository(Car).save({
    distributorId,
    userId,
    carPatent: patenteDePrueba(),
    typeCar: tipo,
  } as Partial<Car>)) as Car;
  await ds.getRepository(VehicleAssignment).save({
    distributorId,
    carId: auto.carId,
    deliveryId,
    assignedAt: new Date(),
  } as Partial<VehicleAssignment>);
}

/** Completa el escenario de la T1 con lo que necesitan los pedidos. */
export async function sembrarBaseT2(
  app: TestApp,
  e: Escenario,
): Promise<EscenarioT2> {
  const ds = app.get(DataSource);
  const zonas = ds.getRepository(CoverageZone);
  await zonas.save({
    distributorId: e.distA.id,
    name: 'Centro',
    area: cuadrado(ZONA_CENTRO.lng, ZONA_CENTRO.lat),
    surchargeType: 'percentage',
    surchargeValue: 10,
  } as unknown as Partial<CoverageZone>);
  await zonas.save({
    distributorId: e.distA.id,
    name: 'Norte',
    area: cuadrado(ZONA_NORTE.lng, ZONA_NORTE.lat),
    surchargeType: 'percentage',
    surchargeValue: 25,
  } as unknown as Partial<CoverageZone>);

  const garrafa = async (distributorId: string, type: string, price = 1000) =>
    (
      (await ds.getRepository(GasCylinder).save({
        type,
        price,
        stock: 100000,
        weight: 10,
        isActive: true,
        distributorId,
      } as Partial<GasCylinder>)) as GasCylinder
    ).gasCylinderId;

  const tercero = await sembrarPersona(app, 'customer', 'tercero', e.distA.id);
  const chofer = async (distributorId: string, etiqueta: string) => {
    const persona = await sembrarPersona(
      app,
      'delivery',
      etiqueta,
      distributorId,
    );
    const [fila] = await ds.query<Array<{ delivery_id: string }>>(
      `SELECT delivery_id FROM delivery WHERE user_id = $1`,
      [persona.userId],
    );
    await conVehiculo(
      ds,
      distributorId,
      persona.userId,
      fila.delivery_id,
      etiqueta === 'chofer-a2' ? 'Moto' : 'Camioneta',
    );
    return { ...persona, deliveryId: fila.delivery_id };
  };
  const choferA2 = await chofer(e.distA.id, 'chofer-a2');
  const choferB = await chofer(e.distB.id, 'chofer-b');
  await conVehiculo(
    ds,
    e.distA.id,
    e.choferA.userId,
    e.choferA.deliveryId,
    'Camioneta',
  );

  const clienteA2 = await sembrarPersona(
    app,
    'customer',
    'cliente-a2',
    e.distA.id,
  );
  e.actores.clienteA2 = cabecerasDe_(
    clienteA2.email,
    'customer-app',
    e.distA.slug,
  );
  e.actores.choferA2 = cabecerasDe_(choferA2.email, 'driver-app');
  e.actores.choferB = cabecerasDe_(choferB.email, 'driver-app');
  e.actores.superEnB = cabecerasDe_(
    e.superAdmin.email,
    'panel-app',
    e.distB.slug,
  );

  return {
    ...e,
    garrafaA: await garrafa(e.distA.id, '10kg'),
    garrafaA2: await garrafa(e.distA.id, '15kg', 1500),
    garrafaB: await garrafa(e.distB.id, '10kg'),
    dirCentro: await direccion(
      ds,
      e.clienteA.userId,
      ZONA_CENTRO,
      'Calle Centro 1',
      true,
    ),
    dirNorte: await direccion(
      ds,
      e.clienteA.userId,
      ZONA_NORTE,
      'Calle Norte 2',
    ),
    dirFuera: await direccion(
      ds,
      e.clienteA.userId,
      FUERA_DE_ZONA,
      'Calle lejana 3',
    ),
    dirB: await direccion(
      ds,
      e.clienteB.userId,
      ZONA_CENTRO,
      'Calle B 1',
      true,
    ),
    dirAjena: await direccion(ds, tercero.userId, ZONA_NORTE, 'Calle del otro'),
    choferA2,
    choferB,
    p: {},
  };
}

export interface OpcionesPedido {
  estado?: OrderStatus;
  metodo?: PaymentMethod.CASH | PaymentMethod.TRANSFER;
  /** De quién es: el cliente de A (por omisión) o el de B. */
  cliente?: 'A' | 'B';
  /** Chofer asignado cuando el estado lo pide (por omisión el de A). */
  chofer?: 'A' | 'A2' | 'B';
  /** Estado del cobro que se deja en el pedido. */
  pago?: PaymentStatus;
  cantidad?: number;
  /** Reserva con seña. */
  reserva?: { sena: number };
}

/**
 * Crea un pedido por la API (como el cliente) y lo lleva al estado pedido con
 * las fechas que exige la base. Devuelve su id.
 */
export async function sembrarPedido(
  ctx: EscenarioT2,
  o: OpcionesPedido = {},
): Promise<string> {
  const ds = ctx.app.get(DataSource);
  const deB = o.cliente === 'B';
  const actor = deB ? 'clienteB' : 'clienteA';
  const body: Record<string, unknown> = {
    customerId: deB ? ctx.clienteB.userId : ctx.clienteA.userId,
    addressId: deB ? ctx.dirB : ctx.dirCentro,
    paymentMethod: o.metodo ?? PaymentMethod.CASH,
    items: [
      {
        gasCylinderId: deB ? ctx.garrafaB : ctx.garrafaA,
        quantity: o.cantidad ?? 1,
        unitPrice: 1,
      },
    ],
  };
  if (o.reserva) {
    const manana = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    body.isReservation = true;
    body.depositAmount = o.reserva.sena;
    body.scheduledDate = manana.toISOString().slice(0, 10);
  }
  const res = await llamar(ctx, 'post', '/orders', actor, body);
  if (res.status !== 201) {
    throw new Error(
      `No se pudo sembrar el pedido (${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
  const id = (res.body as { order_id: string }).order_id;
  const estado = o.estado ?? OrderStatus.PENDING;
  const repo = ds.getRepository(Order);
  const choferId = {
    A: ctx.choferA.deliveryId,
    A2: ctx.choferA2.deliveryId,
    B: ctx.choferB.deliveryId,
  }[o.chofer ?? 'A'];
  const ahora = new Date();
  const pasos: Array<[OrderStatus, Partial<Order>]> = [
    [
      OrderStatus.ACCEPTED,
      { deliveryId: choferId, deliveryCode: '123456', acceptedAt: ahora },
    ],
    [OrderStatus.ON_THE_WAY, { onTheWayAt: ahora }],
    [OrderStatus.DELIVERED, { deliveredAt: ahora }],
  ];
  if (
    estado === OrderStatus.ACCEPTED ||
    estado === OrderStatus.ON_THE_WAY ||
    estado === OrderStatus.DELIVERED
  ) {
    for (const [paso, campos] of pasos) {
      await repo.update({ orderId: id }, { status: paso, ...campos });
      if (paso === estado) break;
    }
  } else if (estado === OrderStatus.CANCELLED) {
    await repo.update(
      { orderId: id },
      { status: estado, ...fechasSegunEstado(estado) },
    );
  }
  if (o.pago) {
    await conBypassManager(ds, ['transiciones', 'saldos'], (m) =>
      m.update(Order, { orderId: id }, { paymentStatus: o.pago }),
    );
  }
  return id;
}

/** Un chofer en el radar de Redis, para el despacho express. */
export async function ubicarChofer(
  app: TestApp,
  userId: string,
  punto: { lng: number; lat: number },
): Promise<void> {
  await app
    .get(RealtimeDispatchPort)
    .reportDriverLocation(userId, punto.lat, punto.lng);
}

export const unico = (): string => randomUUID().slice(0, 8);

/**
 * Manda un pedido con una `Idempotency-Key` nueva y devuelve la clave: el caso
 * que la reusa con otro cuerpo espera 422.
 */
export async function usarClave(
  ctx: ContextoMatriz,
  metodo: 'post' | 'patch',
  ruta: string,
  actor: string,
  body?: object,
): Promise<string> {
  const clave = randomUUID();
  const res = await request(ctx.app.getHttpServer())
    [metodo](ruta)
    .set({ ...ctx.actores[actor], 'Idempotency-Key': clave })
    .send(body);
  if (res.status >= 400) {
    throw new Error(
      `La primera vez con la clave falló (${res.status}): ${JSON.stringify(res.body)}`,
    );
  }
  return clave;
}

/**
 * Deja la clave como «en curso»: borra la respuesta guardada y toma el lock que
 * toma el interceptor mientras el pedido se procesa. Hay que haber usado la
 * clave antes (`usarClave`) para saber la huella del actor y de la ruta.
 */
export async function dejarEnCurso(env: TestEnv, clave: string): Promise<void> {
  const redis = new Redis({
    host: env.redisContainer.getHost(),
    port: env.redisContainer.getMappedPort(6379),
  });
  try {
    const [guardada] = await redis.keys(`idempotency:*:${clave}`);
    const huella = guardada.split(':')[1];
    await redis.del(guardada);
    await redis.set(
      `lock:idempotency-lock:${huella}:${clave}`,
      'otro',
      'PX',
      60000,
    );
  } finally {
    redis.disconnect();
  }
}

/**
 * Para los casos «de otro cliente» que prueba un cliente de la OTRA
 * distribuidora, suma el mismo caso con otro cliente de la MISMA distribuidora
 * (`clienteA2`): el aislamiento por dueño y el aislamiento por distribuidora
 * son dos controles distintos y cada uno tiene que fallar por separado.
 * `distintos` fija el código cuando el de la misma distribuidora no es el mismo
 * (por ejemplo 403 en vez de 404).
 */
export function conMismaDistribuidora<C extends ContextoMatriz>(
  casos: ReadonlyArray<Caso<C>>,
  distintos: Record<string, number> = {},
): Array<Caso<C>> {
  const OTRO = /otro cliente|otro pedido|pedido de otro/i;
  return casos.flatMap((c) =>
    c.actor === 'clienteB' && OTRO.test(c.caso)
      ? [
          c,
          {
            ...c,
            actor: 'clienteA2',
            caso: `${c.caso} (de la misma distribuidora)`,
            esperado: distintos[c.caso] ?? c.esperado,
          },
        ]
      : [c],
  );
}
