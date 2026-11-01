import {
  Body,
  Controller,
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
import { CashSessionService } from '../application/cash-session.service';
import {
  CloseCashSessionPreviewDto,
  PreviewCloseCashSessionDto,
} from '../dto/cash-session.dto';

/** Vista previa del cierre de caja (API v2; ver y cerrar siguen en `/cash-sessions` v1). */
@ApiTags('Finanzas · Cajas (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'cash-sessions', version: '2' })
export class CashSessionV2Controller {
  constructor(private readonly sesiones: CashSessionService) {}

  @Post(':id/close-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Vista previa de la diferencia antes de cerrar la caja',
    description:
      'Con lo que se está contando, devuelve lo esperado (apertura + entradas − salidas de la sesión) y la diferencia (contado − esperado) con la misma cuenta que se guarda al cerrar. No escribe nada.',
  })
  @ApiParam({ name: 'id', description: 'Sesión UUID' })
  @ApiOkResponse({ type: CloseCashSessionPreviewDto })
  @ApiBadRequestResponse({
    description: 'Importe negativo o con más de dos decimales',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La sesión ya está cerrada' })
  vistaPrevia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewCloseCashSessionDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CloseCashSessionPreviewDto> {
    return this.sesiones.vistaPreviaDelCierre(id, dto, distributorId);
  }
}
