import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { EnvasesVencidosException } from '../cylinder-vencido.exception';
import { CylinderState } from '../domain/cylinder-state';
import { asegurarDespachables } from '../domain/despacho';
import type { Envase } from '../domain/envase';
import { DespachoBloqueadoEvent } from '../domain/events/despacho-bloqueado.event';
import { ClockPort } from '../domain/ports/clock.port';
import { CylinderEventsPort } from '../domain/ports/cylinder-events.port';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { DriverPort } from '../domain/ports/driver.port';
import { OrderDispatchPort } from '../domain/ports/order-dispatch.port';
import { Transaccion, UnitOfWorkPort } from '../domain/ports/unit-of-work.port';
import { normalizarSerial } from '../domain/serial-de-envase';
import {
  asegurarPedidoDelChofer,
  asegurarPedidoDespachable,
} from './dispatch-access';
import { aExcepcionHttp } from './domain-error.translator';

/**
 * Carga en el camión los envases (por serial) que salen para un pedido y los
 * despacha (FILLED → DISPATCHED), dejándolos atados al pedido para que la
 * entrega los avance sola.
 *
 * Es atómica: con los envases bloqueados se valida todo antes de escribir y
 * una falla en cualquiera deja a todos como estaban. Un envase con la revisión
 * vencida rechaza la carga completa (409 con la lista de seriales, CU-135);
 * uno sin vencimiento cargado pasa y queda anotado. Si alguno no está lleno,
 * la transición es inválida (400).
 *
 * El pedido tiene que admitir la carga (pendiente, aceptado o en camino). Un
 * chofer sólo carga a pedidos que tiene asignados; uno ajeno o sin chofer no
 * existe para él (404).
 */
@Injectable()
export class AssignCylindersToOrderUseCase {
  constructor(
    private readonly envases: CylinderRepositoryPort,
    private readonly movimientos: CylinderMovementRepositoryPort,
    private readonly pedidos: OrderDispatchPort,
    private readonly choferes: DriverPort,
    private readonly eventos: CylinderEventsPort,
    private readonly uow: UnitOfWorkPort,
    private readonly reloj: ClockPort,
  ) {}

  async execute(
    orderId: string,
    serials: string[],
    distributorId: string,
    actorUserId?: string,
    role?: RoleType,
  ): Promise<Envase[]> {
    if (new Set(serials).size !== serials.length) {
      throw new BadRequestException('Hay seriales repetidos');
    }
    const deliveryId =
      role === RoleType.DELIVERY && actorUserId
        ? await this.choferes.deliveryIdDe(actorUserId)
        : null;

    try {
      return await this.uow.enTransaccion(async (tx) => {
        // Primero el pedido, bloqueado (mismo orden que la confirmación de la
        // entrega: pedido y después envases), y sólo uno de la misma
        // distribuidora (H-90).
        const pedido = await this.pedidos.paraDespacho(
          orderId,
          distributorId,
          tx,
        );
        if (!pedido) throw new NotFoundException('Pedido no encontrado');
        asegurarPedidoDelChofer(pedido, deliveryId, role);
        asegurarPedidoDespachable(pedido);

        const aCargar = await this.bloquearEnElOrdenPedido(
          tx,
          serials,
          distributorId,
        );
        const ahora = this.reloj.ahora();
        asegurarDespachables(aCargar, ahora);

        const asignados: Envase[] = [];
        for (const envase of aCargar) {
          const sinFecha = envase.expiresAt === null;
          const movimiento = envase.transicionar(
            CylinderState.DISPATCHED,
            {
              orderId,
              actorUserId,
              note:
                `Asignado al pedido ${orderId}` +
                (sinFecha ? ' (sin revisión registrada)' : ''),
            },
            ahora,
          );
          asignados.push(await this.envases.guardar(tx, envase));
          await this.movimientos.registrar(movimiento, tx);
        }
        return asignados;
      });
    } catch (error) {
      const traducido = aExcepcionHttp(error);
      // Un despacho rechazado por vencimiento se avisa al panel; el rechazo no depende del aviso.
      if (traducido instanceof EnvasesVencidosException) {
        this.eventos.despachoBloqueado(
          new DespachoBloqueadoEvent(distributorId, orderId, traducido.serials),
        );
      }
      throw traducido;
    }
  }

  /** Si alguno no existe o es de otra distribuidora, 404 sin revelar cuál. */
  private async bloquearEnElOrdenPedido(
    tx: Transaccion,
    serials: string[],
    distributorId: string,
  ): Promise<Envase[]> {
    const encontrados = await this.envases.bloquearPorSerial(
      tx,
      serials,
      distributorId,
    );
    if (encontrados.length !== serials.length) {
      throw new NotFoundException('Envase no encontrado');
    }
    const porSerial = new Map(
      encontrados.map((envase) => [normalizarSerial(envase.serial), envase]),
    );
    // Seriales únicos y todos encontrados: cada uno está en el mapa.
    return serials.map(
      (serial) => porSerial.get(normalizarSerial(serial)) as Envase,
    );
  }
}
