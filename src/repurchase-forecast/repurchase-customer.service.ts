import { BadRequestException, Injectable } from '@nestjs/common';
import { CustomersService } from '../customer/customer.service';
import { UpdateRepurchaseNoticeDto } from './dto/repurchase-request.dto';
import { MotivoSinEstimacion } from './domain/estimacion-de-recompra';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';
import {
  RecompraEstimada,
  RepurchaseEstimatorService,
} from './repurchase-estimator.service';
import {
  DetalleDeInvitacion,
  RepurchaseInvitationDetailService,
} from './repurchase-invitation-detail.service';
import { RepurchaseInvitationService } from './repurchase-invitation.service';

export interface InvitacionConDetalle {
  invitacion: RepurchaseInvitation;
  detalle: DetalleDeInvitacion;
}

export interface AvisoDeRecompra {
  enabled: boolean;
  days: number | null;
  distributorDays: number | null;
}

export interface MiRecompra {
  estimacion: RecompraEstimada | null;
  reason: MotivoSinEstimacion | null;
  aviso: AvisoDeRecompra;
  abierta: InvitacionConDetalle | null;
}

/**
 * Lo que el cliente hace con la recompra anticipada desde su app: ver su fecha
 * estimada (CU-146 de cara al cliente), elegir cómo quiere el aviso (CU-145) y
 * ver o descartar sus invitaciones (CU-106).
 */
@Injectable()
export class RepurchaseCustomerService {
  constructor(
    private readonly estimator: RepurchaseEstimatorService,
    private readonly customers: CustomersService,
    private readonly invitaciones: RepurchaseInvitationService,
    private readonly detalle: RepurchaseInvitationDetailService,
  ) {}

  /**
   * Su fecha estimada en la distribuidora del header y su aviso. Sin
   * estimación explica por qué (nunca le compró a esta distribuidora, tiene
   * pocas compras y no declaró consumo, o dejó de comprar).
   */
  async miRecompra(
    userId: string,
    distributorId: string,
    ahora: Date,
  ): Promise<MiRecompra> {
    const params = await this.estimator.parametros(distributorId);
    const evaluacion = await this.estimator.estimarCliente(
      distributorId,
      userId,
      ahora,
      params,
    );
    const abiertas = await this.invitaciones.abiertasDe(distributorId, [
      userId,
    ]);
    const pendiente = abiertas.get(userId);
    const abierta =
      pendiente && pendiente.expiresAt.getTime() > ahora.getTime()
        ? pendiente
        : null;
    return {
      estimacion: evaluacion?.cliente ?? null,
      reason: evaluacion ? evaluacion.reason : 'no_purchases',
      aviso: await this.aviso(userId, distributorId),
      abierta: abierta ? await this.conDetalle(abierta, ahora) : null,
    };
  }

  /** CU-145. Su preferencia de aviso; con distribuidora, además el valor que rige si no eligió. */
  async aviso(
    userId: string,
    distributorId: string | null,
  ): Promise<AvisoDeRecompra> {
    const ficha = await this.customers.findOneByUserId(userId);
    const params = distributorId
      ? await this.estimator.parametros(distributorId)
      : null;
    return {
      enabled: ficha.repurchaseNoticeEnabled,
      days: ficha.repurchaseNoticeDays,
      distributorDays: params?.anticipationDays ?? null,
    };
  }

  /** CU-145. Guarda cómo quiere el aviso; 400 si no cambia nada. */
  async actualizarAviso(
    userId: string,
    cambios: UpdateRepurchaseNoticeDto,
    distributorId: string | null,
  ): Promise<AvisoDeRecompra> {
    if (cambios.enabled === undefined && cambios.days === undefined) {
      throw new BadRequestException(
        'Mandá enabled (activar o desactivar el aviso) o days (días de anticipación, de 1 a 30, o null para usar los de la distribuidora)',
      );
    }
    await this.customers.guardarAvisoDeRecompra(userId, {
      noticeEnabled: cambios.enabled,
      noticeDays: cambios.days,
    });
    return this.aviso(userId, distributorId);
  }

  async listar(
    userId: string,
    distributorId: string | null,
    soloAbiertas: boolean,
    ahora: Date,
  ): Promise<InvitacionConDetalle[]> {
    const invitaciones = await this.invitaciones.listarDelCliente(userId, {
      distributorId: distributorId ?? undefined,
      abiertasA: soloAbiertas ? ahora : undefined,
    });
    const vistas: InvitacionConDetalle[] = [];
    for (const invitacion of invitaciones) {
      vistas.push(await this.conDetalle(invitacion, ahora));
    }
    return vistas;
  }

  async una(
    userId: string,
    invitationId: string,
  ): Promise<InvitacionConDetalle> {
    return this.conDetalle(
      await this.invitaciones.delCliente(invitationId, userId),
    );
  }

  async conDetalle(
    invitacion: RepurchaseInvitation,
    ahora: Date = new Date(),
  ): Promise<InvitacionConDetalle> {
    return {
      invitacion,
      detalle: await this.detalle.detallar(invitacion, ahora),
    };
  }
}
