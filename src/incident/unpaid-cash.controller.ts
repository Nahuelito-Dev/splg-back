import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UnpaidCashService } from './unpaid-cash.service';
import { IncidentPhotoService } from './incident-photo.service';
import { IncidentMapper } from './incident.mapper';
import { ReportUnpaidCashDto } from './dto/report-unpaid-cash.dto';
import { MotivoDeCobroDto } from '../order/dto/payment-admin.dto';
import { UnpaidCashResponseDto } from './dto/unpaid-cash-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

@ApiTags('Incidents')
@ApiBearerAuth()
@Controller('orders')
export class UnpaidCashController {
  constructor(
    private readonly unpaidCash: UnpaidCashService,
    private readonly incidentPhoto: IncidentPhotoService,
  ) {}

  @Patch(':id/payment/unpaid')
  @Auth(RoleType.DELIVERY)
  @Idempotent()
  @ApiOperation({
    summary: 'El chofer informa que el cliente no pagó el efectivo',
    description:
      'Pasa el pago a `unpaid` y abre una incidencia `unpaid_collection` (avisa a los admins por el panel en vivo, ' +
      'evento `incident:created` con `incidentId`, `orderId`, `distributorId`, `type`, `description`, `createdAt`). Body opcional: `note`. Para adjuntar foto, subirla con ' +
      '`PUT /incidents/{incident.incident_id}/photo`. Sólo el chofer asignado, sólo pedidos `delivered` en efectivo ' +
      'con el pago pendiente. Repetirlo (o reintentar con la misma `Idempotency-Key`) devuelve la misma ' +
      'incidencia, sin duplicar. Un admin lo resuelve con `PATCH /orders/{id}/payment/resolve-unpaid`, que también cierra la incidencia.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: UnpaidCashResponseDto })
  @ApiBadRequestResponse({
    description:
      'El pedido no está entregado, no es en efectivo, o nota inválida',
  })
  @ApiForbiddenResponse({
    description: 'El pedido no está asignado a este chofer',
  })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiConflictResponse({
    description: 'El pago ya no está pendiente (cobrado o resuelto)',
  })
  async report(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportUnpaidCashDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<UnpaidCashResponseDto> {
    const { order, incident } = await this.unpaidCash.report(
      id,
      dto,
      user.user_id,
      distributorId,
    );
    await this.incidentPhoto.firmar(incident);
    const res = new UnpaidCashResponseDto();
    res.orderId = order.orderId;
    res.paymentStatus = order.paymentStatus;
    res.incident = IncidentMapper.toDto(incident);
    return res;
  }

  @Patch(':id/payment/register-unpaid')
  @Permiso('pedidos.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'El admin informa el impago de un efectivo entregado',
    description:
      'Para cuando el chofer no lo informó (no lo hizo, ya no está). Mismo efecto que `PATCH /orders/{id}/payment/unpaid`: pasa el pago a `unpaid` y abre UNA incidencia `unpaid_collection` (reportada por el admin). `reason` es obligatorio (10 a 500 caracteres) y queda en el historial de estados, en la auditoría y en el pedido (`paymentResolutionNote`, `paymentResolvedBy/At`; `resolve-unpaid` los reemplaza al cerrar el impago). Sólo pedidos `delivered` en efectivo con el pago `pending`; repetirlo devuelve la misma incidencia. Se cierra con `PATCH /orders/{id}/payment/resolve-unpaid`. `X-Distributor` es obligatorio para el super admin.',
  })
  @ApiOkResponse({ type: UnpaidCashResponseDto })
  @ApiBadRequestResponse({
    description:
      'Motivo ausente o inválido, el pedido no está entregado o no es en efectivo, o falta la distribuidora',
  })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente o de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'El pago ya no está pendiente (cobrado o resuelto)',
  })
  async registerUnpaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MotivoDeCobroDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<UnpaidCashResponseDto> {
    const { order, incident } = await this.unpaidCash.reportByAdmin(
      id,
      dto.reason,
      user.user_id,
      distributorId,
    );
    await this.incidentPhoto.firmar(incident);
    const res = new UnpaidCashResponseDto();
    res.orderId = order.orderId;
    res.paymentStatus = order.paymentStatus;
    res.incident = IncidentMapper.toDto(incident);
    return res;
  }
}
