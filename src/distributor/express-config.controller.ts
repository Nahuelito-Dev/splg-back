import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  ExpressConfigDto,
  ExpressConfigResponseDto,
} from './dto/express-config.dto';
import { ExpressSettingsService } from './express-settings.service';
import { Permiso } from '../common/decorators/permiso.decorator';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)"), cuerpo fuera de los límites (detalle por campo) o horario que no empieza antes de terminar';

/** Parámetros de la compra express (CU-148, CU-149, CU-172). */
@ApiTags('Configuración · Parámetros por distribuidora')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('module-config/express_dispatch')
export class ExpressConfigController {
  constructor(private readonly express: ExpressSettingsService) {}

  @Permiso('configuracion.ver')
  @Get()
  @ApiOperation({
    summary: 'Parámetros de la compra express de la distribuidora',
    description:
      'Sin configuración la modalidad express está apagada (`enabled: false`, `isDefault: true`).',
  })
  @ApiOkResponse({ type: ExpressConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  get(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ExpressConfigResponseDto> {
    return this.express.vigentes(distributorId);
  }

  @Permiso('configuracion.gestionar')
  @Put()
  @ApiOperation({
    summary: 'Cambiar los parámetros de la compra express',
    description:
      'Reemplaza la configuración: lo que no se manda toma su valor por omisión. Rige para los pedidos que se cotizan o crean desde ese momento (en otras instancias del servidor, como máximo un minuto después). La ventana de la oferta rige para las ofertas nuevas.',
  })
  @ApiOkResponse({ type: ExpressConfigResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  put(
    @Body() dto: ExpressConfigDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ExpressConfigResponseDto> {
    return this.express.guardar(distributorId, dto, actorUserId);
  }
}
