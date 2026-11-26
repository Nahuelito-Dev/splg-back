import { Injectable } from '@nestjs/common';
import { RoleType } from '../common/constants/role-type.enum';
import { AssignCylindersToOrderUseCase } from './application/assign-cylinders-to-order.use-case';
import {
  AltaDeEnvase,
  CreateCylinderUseCase,
} from './application/create-cylinder.use-case';
import { CylinderQueryService } from './application/cylinder-query.service';
import { DeliverOrderCylindersUseCase } from './application/deliver-order-cylinders.use-case';
import { RetireCylinderUseCase } from './application/retire-cylinder.use-case';
import {
  TransicionDeEnvase,
  TransitionCylinderUseCase,
} from './application/transition-cylinder.use-case';
import { UpdateCylinderUseCase } from './application/update-cylinder.use-case';
import type { CambiosDeEnvase } from './domain/envase';
import type {
  EnvaseVista,
  FiltrosDeEnvases,
  MovimientoVista,
} from './domain/ports/cylinder-query.port';
import type { Transaccion } from './domain/ports/unit-of-work.port';

export type { FiltrosDeEnvases } from './domain/ports/cylinder-query.port';

/**
 * Fachada del módulo de envases: la API que consumen el controller y los
 * otros módulos (recupero, exportaciones). No tiene reglas: cada operación la
 * resuelve un caso de uso de `application/` y las reglas son del dominio
 * (`domain/`). Las escrituras devuelven el envase como quedó.
 */
@Injectable()
export class CylinderService {
  constructor(
    private readonly crear: CreateCylinderUseCase,
    private readonly editar: UpdateCylinderUseCase,
    private readonly transicionar: TransitionCylinderUseCase,
    private readonly baja: RetireCylinderUseCase,
    private readonly asignar: AssignCylindersToOrderUseCase,
    private readonly entregar: DeliverOrderCylindersUseCase,
    private readonly consultas: CylinderQueryService,
  ) {}

  /** Alta en el depósito. Serial duplicado en la distribuidora: 409. */
  async create(
    datos: AltaDeEnvase,
    distributorId: string,
  ): Promise<EnvaseVista> {
    return (await this.crear.execute(datos, distributorId)).snapshot();
  }

  /** Listado con filtros; devuelve la página y el total sin paginar. */
  findAll(
    distributorId?: string | null,
    filtros: FiltrosDeEnvases = {},
  ): Promise<[EnvaseVista[], number]> {
    return this.consultas.findAll(distributorId, filtros);
  }

  /** Envase por id, acotado a la distribuidora si se pasa (404). */
  findOne(id: string, distributorId?: string | null): Promise<EnvaseVista> {
    return this.consultas.findOne(id, distributorId);
  }

  /** Envase por serial, dentro de la distribuidora (404). */
  findBySerial(serial: string, distributorId: string): Promise<EnvaseVista> {
    return this.consultas.findBySerial(serial, distributorId);
  }

  /** Cambio de estado por la máquina de estados, con su movimiento. */
  async transition(
    id: string,
    datos: TransicionDeEnvase,
    distributorId: string,
    actorUserId?: string,
    role?: RoleType,
  ): Promise<EnvaseVista> {
    await this.transicionar.execute(
      id,
      datos,
      distributorId,
      actorUserId,
      role,
    );
    return this.findOne(id, distributorId);
  }

  /** Edición de datos maestros; el estado no se toca. */
  async update(
    id: string,
    cambios: CambiosDeEnvase,
    distributorId: string,
  ): Promise<EnvaseVista> {
    await this.editar.execute(id, cambios, distributorId);
    return this.findOne(id, distributorId);
  }

  /** Baja común (desde el depósito o devuelto vacío), con motivo. */
  async retire(
    id: string,
    reason: string,
    distributorId: string,
    actorUserId?: string,
  ): Promise<EnvaseVista> {
    await this.baja.execute(id, reason, distributorId, actorUserId);
    return this.findOne(id, distributorId);
  }

  /** Baja por pérdida (CU-108), dentro de la transacción de quien decide. */
  retireLost(
    id: string,
    reason: string,
    distributorId: string,
    actorUserId: string,
    tx: Transaccion,
  ): Promise<void> {
    return this.baja.porPerdida(id, reason, distributorId, actorUserId, tx);
  }

  /** Carga de envases a un pedido (FILLED → DISPATCHED), atómica. */
  async assignToOrder(
    orderId: string,
    serials: string[],
    distributorId: string,
    actorUserId?: string,
    role?: RoleType,
  ): Promise<EnvaseVista[]> {
    const asignados = await this.asignar.execute(
      orderId,
      serials,
      distributorId,
      actorUserId,
      role,
    );
    return asignados.map((envase) => envase.snapshot());
  }

  /** El pedido se entregó: sus envases despachados pasan al cliente. */
  onOrderDelivered(
    orderId: string,
    distributorId?: string | null,
    tx?: Transaccion,
  ): Promise<number> {
    return this.entregar.execute(orderId, distributorId, tx);
  }

  /** Historial de movimientos del envase, en orden cronológico. */
  getHistory(
    id: string,
    distributorId?: string | null,
  ): Promise<MovimientoVista[]> {
    return this.consultas.getHistory(id, distributorId);
  }
}
