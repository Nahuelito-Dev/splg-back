import { NotFoundException } from '@nestjs/common';
import { CylinderState } from '../domain/cylinder-state';
import {
  DatosDeEnvase,
  Envase,
  MovimientoDeEnvase,
  NuevaRevision,
  NuevoEnvase,
} from '../domain/envase';
import { EnvaseEnConflictoError } from '../domain/errors/cylinder-rule.errors';
import { DespachoBloqueadoEvent } from '../domain/events/despacho-bloqueado.event';
import { EnvaseDevueltoEvent } from '../domain/events/envase-devuelto.event';
import { ClockPort } from '../domain/ports/clock.port';
import { ContainerAccountPort } from '../domain/ports/container-account.port';
import { CylinderEventsPort } from '../domain/ports/cylinder-events.port';
import { CylinderInspectionRepositoryPort } from '../domain/ports/cylinder-inspection.repository.port';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { DriverPort } from '../domain/ports/driver.port';
import {
  OrderDispatchPort,
  PedidoParaDespacho,
} from '../domain/ports/order-dispatch.port';
import { ProductCatalogPort } from '../domain/ports/product-catalog.port';
import { Transaccion, UnitOfWorkPort } from '../domain/ports/unit-of-work.port';
import { normalizarSerial } from '../domain/serial-de-envase';

/**
 * Dobles en memoria de los puertos de envases, para probar el dominio y los
 * casos de uso sin base ni otros módulos.
 */

export const DIST = 'dist-1';
export const AHORA = new Date('2026-10-15T15:00:00.000Z');
const DIA = 24 * 60 * 60 * 1000;

/** Un instante a `n` días de `AHORA`. */
export const enDias = (n: number): Date => new Date(AHORA.getTime() + n * DIA);

export function datosDeEnvase(
  over: Partial<DatosDeEnvase> = {},
): DatosDeEnvase {
  return {
    cylinderId: 'cyl-1',
    distributorId: DIST,
    serial: 'SN-001',
    gasCylinderId: null,
    state: CylinderState.IN_DEPOT,
    currentCustomerId: null,
    currentOrderId: null,
    deposit: 0,
    photoKey: null,
    manufacturedAt: null,
    lastInspectionAt: null,
    expiresAt: null,
    createdAt: AHORA,
    updatedAt: AHORA,
    ...over,
  };
}

export const unEnvase = (over: Partial<DatosDeEnvase> = {}): Envase =>
  Envase.rehidratar(datosDeEnvase(over));

/** Lo que se deshace si la transacción falla. */
interface Reversible {
  foto(): () => void;
}

export class EnvasesEnMemoria
  extends CylinderRepositoryPort
  implements Reversible
{
  private filas = new Map<string, DatosDeEnvase>();
  /** Bitácora de locks, en el orden en que se tomaron. */
  readonly bloqueos: string[] = [];

  constructor(...iniciales: DatosDeEnvase[]) {
    super();
    for (const datos of iniciales) this.filas.set(datos.cylinderId, datos);
  }

  /** El envase como está guardado. */
  ver(cylinderId: string): DatosDeEnvase {
    const datos = this.filas.get(cylinderId);
    if (!datos) throw new Error(`No hay envase ${cylinderId}`);
    return datos;
  }

  todos(): DatosDeEnvase[] {
    return [...this.filas.values()];
  }

  foto(): () => void {
    const copia = new Map(
      [...this.filas].map(([id, datos]) => [id, { ...datos }]),
    );
    return () => {
      this.filas = copia;
    };
  }

  crear(nuevo: NuevoEnvase): Promise<Envase> {
    this.rechazarSerialRepetido(nuevo.distributorId, nuevo.serial);
    const datos = datosDeEnvase({
      ...nuevo,
      cylinderId: `cyl-${this.filas.size + 1}`,
    });
    this.filas.set(datos.cylinderId, datos);
    return Promise.resolve(Envase.rehidratar(datos));
  }

  verPedidoActual(
    _tx: Transaccion,
    cylinderId: string,
    distributorId: string,
  ): Promise<{ currentOrderId: string | null } | null> {
    const datos = this.propio(cylinderId, distributorId);
    return Promise.resolve(
      datos ? { currentOrderId: datos.currentOrderId } : null,
    );
  }

  bloquear(
    _tx: Transaccion,
    cylinderId: string,
    distributorId: string,
  ): Promise<Envase | null> {
    const datos = this.propio(cylinderId, distributorId);
    if (datos) this.bloqueos.push(`envase:${datos.cylinderId}`);
    return Promise.resolve(datos ? Envase.rehidratar(datos) : null);
  }

  bloquearPorSerial(
    _tx: Transaccion,
    serials: string[],
    distributorId: string,
  ): Promise<Envase[]> {
    const buscados = new Set(serials.map(normalizarSerial));
    const encontrados = this.todos()
      .filter(
        (d) =>
          d.distributorId === distributorId &&
          buscados.has(normalizarSerial(d.serial)),
      )
      .sort((a, b) =>
        normalizarSerial(a.serial).localeCompare(normalizarSerial(b.serial)),
      );
    for (const d of encontrados) this.bloqueos.push(`envase:${d.cylinderId}`);
    return Promise.resolve(encontrados.map((d) => Envase.rehidratar(d)));
  }

  bloquearDespachadosDelPedido(
    _tx: Transaccion,
    orderId: string,
    distributorId?: string | null,
  ): Promise<Envase[]> {
    const despachados = this.todos().filter(
      (d) =>
        d.currentOrderId === orderId &&
        d.state === CylinderState.DISPATCHED &&
        (!distributorId || d.distributorId === distributorId),
    );
    return Promise.resolve(despachados.map((d) => Envase.rehidratar(d)));
  }

  guardar(_tx: Transaccion, envase: Envase): Promise<Envase> {
    const datos = envase.snapshot();
    this.rechazarSerialRepetido(
      datos.distributorId,
      datos.serial,
      datos.cylinderId,
    );
    this.filas.set(datos.cylinderId, datos);
    return Promise.resolve(Envase.rehidratar(datos));
  }

  private propio(
    cylinderId: string,
    distributorId: string,
  ): DatosDeEnvase | null {
    const datos = this.filas.get(cylinderId);
    return datos && datos.distributorId === distributorId ? datos : null;
  }

  private rechazarSerialRepetido(
    distributorId: string,
    serial: string,
    salvo?: string,
  ): void {
    const repetido = this.todos().some(
      (d) =>
        d.cylinderId !== salvo &&
        d.distributorId === distributorId &&
        normalizarSerial(d.serial) === normalizarSerial(serial),
    );
    if (repetido) {
      throw new EnvaseEnConflictoError(
        'El serial ya existe en tu distribuidora',
      );
    }
  }
}

export class MovimientosEnMemoria
  extends CylinderMovementRepositoryPort
  implements Reversible
{
  asentados: MovimientoDeEnvase[] = [];

  foto(): () => void {
    const copia = [...this.asentados];
    return () => {
      this.asentados = copia;
    };
  }

  registrar(movimiento: MovimientoDeEnvase): Promise<void> {
    this.asentados.push(movimiento);
    return Promise.resolve();
  }
}

export class RevisionesEnMemoria
  extends CylinderInspectionRepositoryPort
  implements Reversible
{
  asentadas: NuevaRevision[] = [];

  foto(): () => void {
    const copia = [...this.asentadas];
    return () => {
      this.asentadas = copia;
    };
  }

  registrar(_tx: Transaccion, revision: NuevaRevision): Promise<void> {
    this.asentadas.push(revision);
    return Promise.resolve();
  }
}

/** Transacción en memoria: si el trabajo falla, lo escrito se deshace. */
export class UnidadDeTrabajoEnMemoria extends UnitOfWorkPort {
  private readonly participantes: Reversible[];
  abiertas = 0;

  constructor(...participantes: Reversible[]) {
    super();
    this.participantes = participantes;
  }

  async enTransaccion<T>(trabajo: (tx: Transaccion) => Promise<T>): Promise<T> {
    this.abiertas += 1;
    const deshacer = this.participantes.map((p) => p.foto());
    try {
      return await trabajo({ numero: this.abiertas });
    } catch (error) {
      for (const volver of deshacer) volver();
      throw error;
    }
  }
}

export class RelojFijo extends ClockPort {
  constructor(private instante: Date = AHORA) {
    super();
  }

  ahora(): Date {
    return this.instante;
  }

  poner(instante: Date): void {
    this.instante = instante;
  }
}

export class EventosRegistrados extends CylinderEventsPort {
  readonly bloqueados: DespachoBloqueadoEvent[] = [];
  readonly devueltos: EnvaseDevueltoEvent[] = [];

  despachoBloqueado(evento: DespachoBloqueadoEvent): void {
    this.bloqueados.push(evento);
  }

  envaseDevuelto(evento: EnvaseDevueltoEvent): void {
    this.devueltos.push(evento);
  }
}

export class PedidosEnMemoria extends OrderDispatchPort {
  private readonly pedidos = new Map<
    string,
    PedidoParaDespacho & { distributorId: string }
  >();

  constructor(private readonly bitacora: string[] = []) {
    super();
  }

  poner(
    pedido: Partial<PedidoParaDespacho> & { orderId: string },
    distributorId = DIST,
  ): void {
    this.pedidos.set(pedido.orderId, {
      customerId: 'cust-1',
      status: 'pending',
      deliveryId: null,
      ...pedido,
      distributorId,
    });
  }

  paraDespacho(
    orderId: string,
    distributorId: string,
  ): Promise<PedidoParaDespacho | null> {
    const pedido = this.pedidos.get(orderId);
    if (!pedido || pedido.distributorId !== distributorId) {
      return Promise.resolve(null);
    }
    this.bitacora.push(`pedido:${orderId}`);
    return Promise.resolve(pedido);
  }

  titular(
    orderId: string,
    distributorId?: string | null,
  ): Promise<{ customerId: string } | null> {
    const pedido = this.pedidos.get(orderId);
    if (!pedido || (distributorId && pedido.distributorId !== distributorId)) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ customerId: pedido.customerId });
  }
}

export class ChoferesEnMemoria extends DriverPort {
  constructor(private readonly porUsuario: Record<string, string> = {}) {
    super();
  }

  deliveryIdDe(userId: string): Promise<string | null> {
    return Promise.resolve(this.porUsuario[userId] ?? null);
  }
}

export class CatalogoEnMemoria extends ProductCatalogPort {
  constructor(private readonly productos: string[] = []) {
    super();
  }

  asegurarProducto(gasCylinderId: string): Promise<void> {
    if (!this.productos.includes(gasCylinderId)) {
      return Promise.reject(new NotFoundException('Producto no encontrado'));
    }
    return Promise.resolve();
  }
}

export class CuentaDeEnvasesEnMemoria extends ContainerAccountPort {
  readonly descuentos: Array<{
    tx: Transaccion;
    customerUserId: string;
    cylinderId: string;
    orderId: string | null;
  }> = [];
  falla: Error | null = null;

  descontarPropioDevuelto(
    tx: Transaccion,
    datos: {
      distributorId: string;
      customerUserId: string;
      cylinderId: string;
      orderId: string | null;
    },
  ): Promise<void> {
    if (this.falla) return Promise.reject(this.falla);
    this.descuentos.push({
      tx,
      customerUserId: datos.customerUserId,
      cylinderId: datos.cylinderId,
      orderId: datos.orderId,
    });
    return Promise.resolve();
  }
}
