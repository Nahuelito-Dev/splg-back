import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { OrderLookupService } from '../order/lookup/order-lookup.service';
import { dentroDeLaVentana } from './domain/estimacion-de-recompra';
import {
  RepurchaseEstimateSource,
  RepurchaseInvitation,
  RepurchaseInvitationStatus,
  SuggestedItem,
} from './entities/repurchase-invitation.entity';
import {
  ParametrosDeRecompra,
  RecompraEstimada,
  RepurchaseEstimatorService,
} from './repurchase-estimator.service';
import { RepurchaseInvitationService } from './repurchase-invitation.service';
import { RepurchaseNotifier } from './repurchase-notifier';
import { RepurchaseSuggestionService } from './repurchase-suggestion.service';

const MS_POR_HORA = 3_600_000;
const MS_POR_DIA = 86_400_000;

/** Por qué un cliente que se evaluó no recibió invitación. */
export type MotivoDeOmision =
  | 'notice_disabled'
  | 'not_yet'
  | 'recent_order'
  | 'cooldown'
  | 'same_cycle'
  | 'no_stock'
  | 'no_address';

export interface CandidatoDeInvitacion {
  userId: string;
  fullName: string | null;
  projectedDepletionAt: Date;
  source: RepurchaseEstimateSource;
  items: SuggestedItem[];
}

export interface ResultadoDeCorrida {
  /** Clientes con una fecha estimada. */
  evaluated: number;
  /** Invitaciones emitidas (o que se emitirían con `dryRun`). */
  invited: number;
  /** Invitaciones abiertas que vencieron en esta corrida. */
  expired: number;
  skipped: Record<MotivoDeOmision, number>;
  /** Con `dryRun`, a quién se invitaría; nunca se escribe ni se avisa. */
  candidates: CandidatoDeInvitacion[];
}

/**
 * La corrida diaria de la recompra anticipada (CU-106) de una distribuidora:
 * vence las invitaciones sin respuesta, estima a los clientes y abre una
 * invitación con el pedido precargado a los que se les acaba el gas dentro de
 * su anticipación. Es idempotente: una segunda corrida el mismo día no invita a
 * quien ya tiene una abierta ni a quien la tuvo hace menos del intervalo
 * mínimo. Y como mucho hay una invitación por ciclo de consumo: después de una
 * vencida o descartada no se vuelve a invitar al cliente hasta que haya una
 * compra nueva o pase un ciclo estimado completo (lo que dura la última compra).
 * El proceso viene apagado: con `enabled` en 0 no corre.
 */
@Injectable()
export class RepurchaseForecastService {
  private readonly logger = new Logger(RepurchaseForecastService.name);

  constructor(
    private readonly estimator: RepurchaseEstimatorService,
    private readonly invitaciones: RepurchaseInvitationService,
    private readonly sugerencias: RepurchaseSuggestionService,
    private readonly pedidos: OrderLookupService,
    private readonly notifier: RepurchaseNotifier,
  ) {}

  /**
   * Cierra sin efecto las invitaciones abiertas a las que el cliente se
   * adelantó haciendo un pedido por su cuenta, y vence las que pasaron su
   * vigencia sin respuesta. Avisa a la app de las dos. Devuelve cuántas
   * vencieron.
   */
  async vencer(ahora: Date, distributorId?: string): Promise<number> {
    await this.cerrarLasQueSeAdelantaron(distributorId, ahora);
    const vencidas = await this.invitaciones.vencerVencidas(
      ahora,
      distributorId,
    );
    for (const invitacion of vencidas) {
      await this.notifier.cerrada(invitacion, 'expired');
    }
    return vencidas.length;
  }

  /**
   * Cierra sin efecto las invitaciones abiertas de una distribuidora que ya no
   * está activa: el cliente no puede aceptarlas y no tiene que verlas.
   */
  async cerrarLasDeUnaDistribuidoraInactiva(
    distributorId: string,
    ahora: Date,
  ): Promise<number> {
    let cerradas = 0;
    for (const invitacion of await this.invitaciones.abiertas(distributorId)) {
      if (await this.invitaciones.cancelar(invitacion.invitationId, ahora)) {
        await this.notifier.cerrada(invitacion, 'cancelled');
        cerradas += 1;
      }
    }
    return cerradas;
  }

  async ejecutar(
    distributorId: string,
    ahora: Date,
    opciones: { dryRun?: boolean } = {},
  ): Promise<ResultadoDeCorrida> {
    const dryRun = opciones.dryRun === true;
    const params = await this.estimator.parametros(distributorId);
    if (!params.enabled && !dryRun) {
      throw new ConflictException(
        'La recompra anticipada está apagada para esta distribuidora: activala en Parámetros (enabled)',
      );
    }
    const expired = dryRun ? 0 : await this.vencer(ahora, distributorId);
    const estimadas = await this.estimator.estimar(
      distributorId,
      ahora,
      params,
    );
    const [recientes, ultimas] = await Promise.all([
      this.pedidos.clientesConPedidoVigente(
        distributorId,
        new Date(ahora.getTime() - params.recentOrderDays * MS_POR_DIA),
      ),
      this.invitaciones.ultimasPorCliente(distributorId, ahora),
    ]);

    const resultado: ResultadoDeCorrida = {
      evaluated: estimadas.length,
      invited: 0,
      expired,
      skipped: {
        notice_disabled: 0,
        not_yet: 0,
        recent_order: 0,
        cooldown: 0,
        same_cycle: 0,
        no_stock: 0,
        no_address: 0,
      },
      candidates: [],
    };
    for (const cliente of estimadas) {
      const omitir = this.motivoDeOmision(
        cliente,
        ahora,
        recientes,
        ultimas,
        params,
      );
      if (omitir) {
        resultado.skipped[omitir] += 1;
        continue;
      }
      const armada = await this.sugerencias.armar(
        distributorId,
        cliente.userId,
        cliente.habits,
      );
      if (!armada.ok) {
        resultado.skipped[armada.reason] += 1;
        continue;
      }
      const { sugerencia } = armada;
      if (dryRun) {
        resultado.invited += 1;
        resultado.candidates.push({
          userId: cliente.userId,
          fullName: cliente.fullName,
          projectedDepletionAt: cliente.estimate.estimatedAt,
          source: cliente.estimate.source,
          items: sugerencia.items,
        });
        continue;
      }
      const invitacion = await this.abrir(
        distributorId,
        cliente,
        sugerencia,
        params,
        ahora,
      );
      if (!invitacion) {
        resultado.skipped.cooldown += 1;
        continue;
      }
      resultado.invited += 1;
      await this.notifier.invitar(invitacion);
    }
    this.logger.log(
      `Recompra ${distributorId}${dryRun ? ' (simulada)' : ''}: ${resultado.evaluated} evaluado(s), ${resultado.invited} invitación(es), ${resultado.expired} vencida(s)`,
    );
    return resultado;
  }

  private async cerrarLasQueSeAdelantaron(
    distributorId: string | undefined,
    ahora: Date,
  ): Promise<void> {
    for (const invitacion of await this.invitaciones.abiertas(distributorId)) {
      const seAdelanto = await this.pedidos.hayPedidoDesde(
        invitacion.distributorId,
        invitacion.userId,
        invitacion.createdAt,
      );
      if (
        seAdelanto &&
        (await this.invitaciones.cancelar(invitacion.invitationId, ahora))
      ) {
        await this.notifier.cerrada(invitacion, 'cancelled');
      }
    }
  }

  private motivoDeOmision(
    cliente: RecompraEstimada,
    ahora: Date,
    recientes: ReadonlySet<string>,
    ultimas: ReadonlyMap<string, RepurchaseInvitation>,
    params: ParametrosDeRecompra,
  ): MotivoDeOmision | null {
    if (!cliente.noticeEnabled) return 'notice_disabled';
    if (
      !dentroDeLaVentana(
        cliente.estimate.estimatedAt,
        cliente.noticeDays,
        ahora,
      )
    ) {
      return 'not_yet';
    }
    if (recientes.has(cliente.userId)) return 'recent_order';
    const ultima = ultimas.get(cliente.userId);
    if (!ultima) return null;
    const cierre = ultima.respondedAt ?? ultima.createdAt;
    if (
      ultima.status === RepurchaseInvitationStatus.PENDING ||
      cierre.getTime() >= ahora.getTime() - params.minIntervalDays * MS_POR_DIA
    ) {
      return 'cooldown';
    }
    // Una por ciclo: si ya se la invitó desde su última compra, se espera a una
    // compra nueva o a que pase un ciclo estimado completo.
    const { lastDeliveredAt, estimatedAt } = cliente.estimate;
    const ciclo = estimatedAt.getTime() - lastDeliveredAt.getTime();
    const delMismoCiclo =
      ultima.createdAt.getTime() > lastDeliveredAt.getTime();
    if (delMismoCiclo && ultima.createdAt.getTime() > ahora.getTime() - ciclo) {
      return 'same_cycle';
    }
    return null;
  }

  private abrir(
    distributorId: string,
    cliente: RecompraEstimada,
    sugerencia: {
      items: SuggestedItem[];
      addressId: string;
      timeSlotId: string | null;
      paymentMethod: RepurchaseInvitation['paymentMethod'];
    },
    params: ParametrosDeRecompra,
    ahora: Date,
  ): Promise<RepurchaseInvitation | null> {
    return this.invitaciones.abrir({
      distributorId,
      userId: cliente.userId,
      addressId: sugerencia.addressId,
      timeSlotId: sugerencia.timeSlotId,
      paymentMethod: sugerencia.paymentMethod,
      projectedDepletionAt: cliente.estimate.estimatedAt,
      estimateSource: cliente.estimate.source,
      suggestedItems: sugerencia.items,
      expiresAt: new Date(
        ahora.getTime() + params.invitationTtlHours * MS_POR_HORA,
      ),
    });
  }
}
