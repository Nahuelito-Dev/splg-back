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
import { UnpaidCashResponseDto } from './dto/unpaid-cash-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

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
    @CurrentDistributor() distributorId: string | null,
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
}
