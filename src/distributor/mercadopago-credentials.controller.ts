import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  MercadoPagoCredentialsResponseDto,
  SaveMercadoPagoCredentialsDto,
} from './dto/mercadopago-credentials.dto';
import { MercadoPagoCredentialsService } from './mercadopago-credentials.service';
import { Permiso } from '../common/decorators/permiso.decorator';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/** Cuenta de Mercado Pago propia de la distribuidora (API v2). */
@ApiTags('Distributors')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'distributor/mercadopago-credentials', version: '2' })
export class MercadoPagoCredentialsController {
  constructor(private readonly credentials: MercadoPagoCredentialsService) {}

  @Permiso('configuracion.ver')
  @Get()
  @ApiOperation({
    summary: 'Cuenta de Mercado Pago con la que cobra la distribuidora',
    description:
      'Dice si se cobra con una cuenta propia (`own`) o con la del sistema (`system`). Los valores se devuelven enmascarados: nunca en claro.',
  })
  @ApiOkResponse({ type: MercadoPagoCredentialsResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  status(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MercadoPagoCredentialsResponseDto> {
    return this.credentials.status(distributorId);
  }

  @Permiso('configuracion.gestionar')
  @Put()
  @ApiOperation({
    summary: 'Cargar o reemplazar la cuenta propia de Mercado Pago',
    description:
      'Verifica el access token contra Mercado Pago antes de guardar; los tres valores se guardan cifrados. Desde que queda activa, los cobros, devoluciones, notificaciones y la conciliación de la distribuidora usan esta cuenta.',
  })
  @ApiOkResponse({ type: MercadoPagoCredentialsResponseDto })
  @ApiBadRequestResponse({
    description: `Datos inválidos, o ${FALTA_DISTRIBUIDORA}`,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Mercado Pago rechazó el access token; no se guardó nada',
  })
  @ApiBadGatewayResponse({
    description: 'Mercado Pago no respondió; no se guardó nada',
  })
  @ApiServiceUnavailableResponse({
    description: 'El servidor no tiene CREDENTIALS_ENCRYPTION_KEY',
  })
  save(
    @Body() dto: SaveMercadoPagoCredentialsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<MercadoPagoCredentialsResponseDto> {
    return this.credentials.save(distributorId, userId, dto);
  }

  @Permiso('configuracion.gestionar')
  @Put('deactivate')
  @ApiOperation({
    summary: 'Desactivar la cuenta propia y volver a la del sistema',
    description:
      'Baja lógica: la fila queda y no se borra. Los cobros vuelven a la cuenta del entorno.',
  })
  @ApiOkResponse({ type: MercadoPagoCredentialsResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiNotFoundResponse({
    description: 'La distribuidora no tiene una cuenta propia activa',
  })
  deactivate(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MercadoPagoCredentialsResponseDto> {
    return this.credentials.deactivate(distributorId);
  }
}
