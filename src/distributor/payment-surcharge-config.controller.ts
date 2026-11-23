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
  PaymentSurchargeConfigDto,
  PaymentSurchargeConfigResponseDto,
} from './dto/payment-surcharge-config.dto';
import { PaymentSurchargeSettingsService } from './payment-surcharge-settings.service';
import { Permiso } from '../common/decorators/permiso.decorator';

const CUERPO_INVALIDO =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)") o porcentaje fuera de 0 a 30 / con más de 2 decimales (detalle por campo)';

/** Recargo por medio de pago de la distribuidora (API v2). */
@ApiTags('Configuración · Recargos por medio de pago (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'payment-surcharges', version: '2' })
export class PaymentSurchargeConfigController {
  constructor(private readonly recargos: PaymentSurchargeSettingsService) {}

  @Permiso('configuracion.ver')
  @Get()
  @ApiOperation({
    summary: 'Recargos por medio de pago de la distribuidora',
    description:
      'Porcentaje que se suma al total del pedido según el medio de pago (Mercado Pago, efectivo). Sin configuración rigen los de omisión: Mercado Pago 10, efectivo 0 (`isDefault: true`).',
  })
  @ApiOkResponse({ type: PaymentSurchargeConfigResponseDto })
  @ApiBadRequestResponse({ description: CUERPO_INVALIDO })
  get(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PaymentSurchargeConfigResponseDto> {
    return this.recargos.vigentes(distributorId);
  }

  @Permiso('configuracion.gestionar')
  @Put()
  @ApiOperation({
    summary: 'Cambiar los recargos por medio de pago',
    description:
      'Reemplaza la configuración: `mercadoPagoPercentage` y `cashPercentage` son obligatorios; omitir uno o mandar `null` es 400. Para volver a los valores por omisión del sistema mandá 10 y 0.',
  })
  @ApiOkResponse({ type: PaymentSurchargeConfigResponseDto })
  @ApiBadRequestResponse({ description: CUERPO_INVALIDO })
  put(
    @Body() dto: PaymentSurchargeConfigDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PaymentSurchargeConfigResponseDto> {
    return this.recargos.guardar(distributorId, dto, actorUserId);
  }
}
