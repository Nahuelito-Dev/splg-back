import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { RefundsService } from '../application/refunds.service';
import { MyRefundResponseDto } from '../dto/my-refund-response.dto';

/** El cliente ve el reintegro de su propio pedido (CU-168). */
@ApiTags('Pagos · Reintegros')
@Auth(RoleType.CUSTOMER)
@Controller()
export class MyRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get('orders/:id/refunds/mine')
  @ApiOperation({
    summary: 'Mis devoluciones de un pedido',
    description:
      'Las devoluciones del pago del pedido, de la más vieja a la más nueva: vacío si no hubo ninguna (pago en efectivo o transferencia, o sin cancelar). El pedido tiene que ser del cliente que consulta.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: [MyRefundResponseDto] })
  @ApiNotFoundResponse({
    description: 'El pedido no existe o es de otro cliente',
  })
  async delPedido(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MyRefundResponseDto[]> {
    const filas = await this.refunds.listarDelCliente(id, user.user_id);
    return filas.map((r) => ({
      kind: r.kind,
      amount: r.amount,
      status: r.status,
      requestedAt: r.createdAt,
      completedAt: r.refundedAt,
    }));
  }
}
