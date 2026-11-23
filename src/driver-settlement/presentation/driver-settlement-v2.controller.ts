import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DriverSettlementQueryService } from '../application/driver-settlement-query.service';
import {
  EfectivoSinRendirDto,
  PreviewDriverSettlementDto,
  SettlementPreviewDto,
} from '../dto/driver-settlement.dto';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { SoloLectura } from '../../audit/solo-lectura.decorator';

/** Vista previa de la rendición del chofer (API v2). */
@ApiTags('Rendiciones del chofer (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
@Controller({ path: 'driver-settlements', version: '2' })
export class DriverSettlementV2Controller {
  constructor(private readonly consultas: DriverSettlementQueryService) {}

  @Permiso('finanzas.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Get('unreported-cash')
  @ApiOperation({
    summary: 'Efectivo cobrado y no rendido, por chofer',
    description:
      'Por chofer, el efectivo de pedidos entregados que todavía no entró en una rendición: cantidad de pedidos, monto (total menos la seña ya paga, calculado en el back), antigüedad del más viejo y si pasó el umbral del aviso (`cash_alerts.minHours`). No incluye los pedidos cuyo cobro resolvió un administrador.',
  })
  @ApiOkResponse({ type: EfectivoSinRendirDto })
  efectivoSinRendir(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EfectivoSinRendirDto> {
    return this.consultas.efectivoSinRendir(distributorId);
  }

  @Permiso('finanzas.gestionar')
  @Post(':id/preview')
  // Sólo calcula (no escribe): pasa en modo soporte y no va al registro de escrituras.
  @SoloLectura()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Vista previa de la diferencia antes de presentar la rendición',
    description:
      'Con el efectivo y los gastos que el chofer está escribiendo, devuelve lo esperado en vivo y la diferencia (declarado + gastos − esperado) con la misma cuenta que se guarda al presentar. No escribe nada. El chofer sólo la ve en sus rendiciones.',
  })
  @ApiParam({ name: 'id', description: 'Rendición UUID' })
  @ApiOkResponse({ type: SettlementPreviewDto })
  @ApiBadRequestResponse({
    description: 'Efectivo o gasto negativo, o con más de dos decimales',
  })
  @ApiNotFoundResponse({
    description:
      'No existe, es de otra distribuidora o (chofer) de otro chofer',
  })
  @ApiConflictResponse({ description: 'La rendición no está abierta' })
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewDriverSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<SettlementPreviewDto> {
    return this.consultas.vistaPrevia(
      id,
      dto,
      distributorId,
      user.role === RoleType.DELIVERY ? user.user_id : undefined,
    );
  }
}
