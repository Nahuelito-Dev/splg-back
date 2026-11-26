import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { ReservationService } from './application/reservation.service';
import { ConfirmDepositV2Dto } from './dto/confirm-deposit-v2.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderMapper } from './order.mapper';
import { Permiso } from '../common/decorators/permiso.decorator';

/** Confirmar la seña de una reserva eligiendo la caja donde entra (API v2). */
@ApiTags('Pedidos · Reservas (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'orders', version: '2' })
export class ReservationV2Controller {
  constructor(private readonly reservas: ReservationService) {}

  @Permiso('pedidos.gestionar')
  @Patch(':id/confirm-deposit')
  @Idempotent()
  @ApiOperation({
    summary: 'Confirmar la seña de una reserva y asentarla en una caja',
    description:
      'Como `PATCH /orders/:id/confirm-deposit` (v1), y la seña entra a la caja de efectivo `cashBoxId` en la misma transacción (obligatoria si hay alguna caja de efectivo activa). Una seña anterior por transferencia o a cuenta corriente se confirma sin asentarla en caja (indicar `cashBoxId` es 400). Repetirlo no asienta otra vez. La seña por Mercado Pago la confirma la pasarela.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID (reserva)' })
  @ApiOkResponse({ type: OrderResponseDto, description: 'Seña confirmada' })
  @ApiBadRequestResponse({
    description:
      'No es una reserva pendiente, la seña es de Mercado Pago, o falta la caja de efectivo',
  })
  @ApiNotFoundResponse({ description: 'Reserva o caja no encontrada' })
  @ApiConflictResponse({
    description: 'La caja rechazó el ingreso (sin sesión abierta, desactivada)',
  })
  async confirmDeposit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmDepositV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const order = await this.reservas.confirmDeposit(
      id,
      distributorId,
      user.user_id,
      dto.cashBoxId,
    );
    return OrderMapper.toDto(order);
  }
}
