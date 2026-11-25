import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { EnvasesVencidosException } from '../cylinder-vencido.exception';
import { CylinderState } from '../domain/cylinder-state';
import type { Envase } from '../domain/envase';
import { DespachoBloqueadoEvent } from '../domain/events/despacho-bloqueado.event';
import { EnvaseDevueltoEvent } from '../domain/events/envase-devuelto.event';
import { ClockPort } from '../domain/ports/clock.port';
import { ContainerAccountPort } from '../domain/ports/container-account.port';
import { CylinderEventsPort } from '../domain/ports/cylinder-events.port';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { DriverPort } from '../domain/ports/driver.port';
import {
  OrderDispatchPort,
  PedidoParaDespacho,
} from '../domain/ports/order-dispatch.port';
import { UnitOfWorkPort } from '../domain/ports/unit-of-work.port';
import {
  asegurarPedidoDelChofer,
  asegurarPedidoDespachable,
} from './dispatch-access';
import { aExcepcionHttp } from './domain-error.translator';

export interface TransicionDeEnvase {
  toState: CylinderState;
  /** Pedido en cuyo contexto ocurre; obligatorio para `with_customer`. */
  orderId?: string;
  note?: string;
}

/**
 * Mueve un envase a otro estado, con su asiento en el historial. La regla de
 * qué transición vale y qué pasa con el tenedor y el pedido es del agregado
 * (`Envase.transicionar`); acá se resuelve con quién se hace: el pedido tiene
 * que ser de la distribuidora y, si actúa un chofer, suyo (404); despachar
 * exige además un pedido que admita la carga (409).
 */
@Injectable()
export class TransitionCylinderUseCase {
  constructor(
    private readonly envases: CylinderRepositoryPort,
    private readonly movimientos: CylinderMovementRepositoryPort,
    private readonly pedidos: OrderDispatchPort,
    private readonly choferes: DriverPort,
    private readonly cuentaDeEnvases: ContainerAccountPort,
    private readonly eventos: CylinderEventsPort,
    private readonly uow: UnitOfWorkPort,
    private readonly reloj: ClockPort,
  ) {}

  async execute(
    cylinderId: string,
    datos: TransicionDeEnvase,
    distributorId: string,
    actorUserId?: string,
    role?: RoleType,
  ): Promise<void> {
    if (datos.toState === CylinderState.RETIRED) {
      throw new BadRequestException(
        'La baja del envase va por PATCH /cylinders/:id/retire, con motivo',
      );
    }
    if (datos.toState === CylinderState.WITH_CUSTOMER && !datos.orderId) {
      throw new BadRequestException(
        'Entregar el envase al cliente requiere indicar el pedido',
      );
    }

    const deliveryId =
      role === RoleType.DELIVERY && actorUserId
        ? await this.choferes.deliveryIdDe(actorUserId)
        : null;

    // Orden de locks igual al de la confirmación de la entrega: primero el/los
    // pedidos (en orden de id) y después el envase. Con el pedido bloqueado una
    // entrega o reasignación concurrente espera y la validación de estado y
    // dueño vale hasta el commit.
    let devuelto: EnvaseDevueltoEvent | null = null;
    try {
      await this.uow.enTransaccion(async (tx) => {
        const visto = await this.envases.verPedidoActual(
          tx,
          cylinderId,
          distributorId,
        );
        if (!visto) throw new NotFoundException('Envase no encontrado');

        const ids = [
          ...new Set(
            [datos.orderId, visto.currentOrderId].filter(
              (v): v is string => !!v,
            ),
          ),
        ].sort();
        const pedidos = new Map<string, PedidoParaDespacho>();
        for (const orderId of ids) {
          // El pedido tiene que ser de la misma distribuidora que el envase (H-90).
          const pedido = await this.pedidos.paraDespacho(
            orderId,
            distributorId,
            tx,
          );
          if (pedido) pedidos.set(orderId, pedido);
        }
        const envase = await this.envases.bloquear(
          tx,
          cylinderId,
          distributorId,
        );
        if (!envase) throw new NotFoundException('Envase no encontrado');
        if (envase.currentOrderId !== visto.currentOrderId) {
          throw new ConflictException(
            'El envase cambió de pedido mientras se procesaba: reintentá',
          );
        }

        const pedido = datos.orderId ? pedidos.get(datos.orderId) : undefined;
        if (datos.orderId && !pedido) {
          throw new NotFoundException('Pedido no encontrado');
        }
        if (role === RoleType.DELIVERY) {
          this.asegurarEnvaseDelChofer(
            envase,
            datos.orderId,
            pedidos,
            deliveryId,
          );
        }
        if (pedido) {
          // Un chofer sólo mueve envases en el contexto de sus propios pedidos.
          asegurarPedidoDelChofer(pedido, deliveryId, role);
          if (datos.toState === CylinderState.DISPATCHED) {
            asegurarPedidoDespachable(pedido);
          }
        }
        const teniaCliente =
          envase.state === CylinderState.WITH_CUSTOMER
            ? envase.currentCustomerId
            : null;
        const movimiento = envase.transicionar(
          datos.toState,
          {
            orderId: datos.orderId,
            actorUserId,
            note: datos.note,
            customerId:
              datos.toState === CylinderState.WITH_CUSTOMER
                ? (pedido?.customerId ?? null)
                : null,
          },
          this.reloj.ahora(),
        );
        await this.envases.guardar(tx, envase);
        await this.movimientos.registrar(movimiento, tx);
        if (
          datos.toState === CylinderState.EMPTY_RETURNED &&
          teniaCliente !== null
        ) {
          // F35 E5: si volvió un envase propio, la cuenta de envases baja uno en esta misma
          // transacción; si el descuento falla, la devolución revierte.
          await this.cuentaDeEnvases.descontarPropioDevuelto(tx, {
            distributorId,
            customerUserId: teniaCliente,
            cylinderId,
            orderId: datos.orderId ?? null,
          });
          devuelto = new EnvaseDevueltoEvent(
            distributorId,
            cylinderId,
            teniaCliente,
            datos.orderId ?? null,
          );
        }
      });
    } catch (error) {
      const traducido = aExcepcionHttp(error);
      // Un despacho rechazado por vencimiento se avisa al panel; el rechazo no depende del aviso.
      if (traducido instanceof EnvasesVencidosException) {
        this.eventos.despachoBloqueado(
          new DespachoBloqueadoEvent(
            distributorId,
            datos.orderId ?? null,
            traducido.serials,
          ),
        );
      }
      throw traducido;
    }
    // Ya con el commit hecho: quien escucha lee el envase devuelto.
    if (devuelto) this.eventos.envaseDevuelto(devuelto);
  }

  /**
   * Reglas del chofer sobre un envase, con el envase y los pedidos bloqueados:
   *  - si el envase ya está atado a un pedido, ese pedido tiene que ser suyo
   *    (si no, el envase no existe para él: 404) y un `orderId` distinto es 409;
   *  - un envase sin pedido sólo se mueve en el contexto de un pedido suyo
   *    (`orderId`); las tareas de depósito son del admin (403).
   */
  private asegurarEnvaseDelChofer(
    envase: Envase,
    orderId: string | undefined,
    pedidos: Map<string, PedidoParaDespacho>,
    deliveryId: string | null,
  ): void {
    if (envase.currentOrderId) {
      const actual = pedidos.get(envase.currentOrderId);
      if (!deliveryId || !actual || actual.deliveryId !== deliveryId) {
        throw new NotFoundException('Envase no encontrado');
      }
      if (orderId && orderId !== envase.currentOrderId) {
        throw new ConflictException(
          'El envase está asignado a otro pedido: no coincide con el pedido indicado',
        );
      }
    } else if (!orderId) {
      throw new ForbiddenException(
        'Un chofer mueve envases sólo en el contexto de uno de sus pedidos',
      );
    }
  }
}
