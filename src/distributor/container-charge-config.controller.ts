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
import { Idempotent } from '../common/decorators/idempotent.decorator';
import {
  ContainerChargeConfigDto,
  ContainerChargeConfigResponseDto,
} from './dto/container-charge-config.dto';
import { ContainerChargeSettingsService } from './container-charge-settings.service';
import { Permiso } from '../common/decorators/permiso.decorator';

/** Cobro opcional de envases por distribuidora (API v2). */
@ApiTags('Configuración · Cobro de envases (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'container-charge', version: '2' })
export class ContainerChargeConfigController {
  constructor(private readonly settings: ContainerChargeSettingsService) {}

  @Permiso('configuracion.ver')
  @Get()
  @ApiOperation({
    summary: 'Estado del cobro de envases',
    description:
      'Sin configuración, el cobro está apagado: el canje de envases es 1:1 y no se bloquean pedidos por falta de precio de envase.',
  })
  @ApiOkResponse({ type: ContainerChargeConfigResponseDto })
  @ApiBadRequestResponse({
    description:
      'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)").',
  })
  get(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ContainerChargeConfigResponseDto> {
    return this.settings.vigentes(distributorId);
  }

  @Permiso('configuracion.gestionar')
  @Put()
  @Idempotent()
  @ApiOperation({
    summary: 'Cambiar el cobro de envases',
    description:
      'Al activarlo se cobran los envases que le faltan al cliente y un tipo sin precio de envase bloquea el pedido. Al apagarlo no se cobran envases.',
  })
  @ApiOkResponse({ type: ContainerChargeConfigResponseDto })
  @ApiBadRequestResponse({
    description:
      'Super admin sin X-Distributor o `enabled` ausente/no booleano (detalle por campo).',
  })
  put(
    @Body() dto: ContainerChargeConfigDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ContainerChargeConfigResponseDto> {
    return this.settings.guardar(distributorId, dto.enabled, actorUserId);
  }
}
