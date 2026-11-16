import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { MODULOS } from './catalogo-de-modulos';
import { CompanyModulesService } from './company-modules.service';
import { CompanyModuleDto, SetCompanyModuleDto } from './dto/modules.dto';

const ID_INVALIDO = 'El identificador de la empresa no es un UUID';
const NO_EXISTE =
  'La empresa no existe o está dada de baja (`COMPANY_NOT_FOUND`)';

/**
 * Módulos de una empresa, del lado de la plataforma (DISENO-PLATAFORMA-ORIXTECH
 * §5.2; API v2, sólo `super_admin`, alcance `plataforma`). La empresa sale del
 * parámetro de ruta: no se leen `X-Distributor` ni `X-Support-Session`.
 */
@ApiTags('Platform')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/companies', version: '2' })
export class PlatformModulesController {
  constructor(private readonly modulos: CompanyModulesService) {}

  @Get(':id/modules')
  @ApiOperation({
    summary: 'Módulos de una empresa',
    description:
      'Todos los módulos del catálogo para la empresa: si los trae su plan (`inPlan`, según la foto del plan que se le asignó), la excepción vigente de la plataforma (`override`), si quedan habilitados (`enabled`), el interruptor de la propia empresa (`companySwitch`), si están en uso (`effective`) y lo que quedaría en curso al apagarlos (`impact`).',
  })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ type: CompanyModuleDto, isArray: true })
  @ApiBadRequestResponse({ description: ID_INVALIDO })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<CompanyModuleDto[]> {
    return this.modulos.deLaPlataforma(id);
  }

  @Put(':id/modules/:key')
  @ApiOperation({
    summary: 'Habilitar o deshabilitar un módulo a una empresa',
    description:
      'Excepción de la plataforma sobre el plan de la empresa: `enabled: true` lo habilita aunque el plan no lo traiga, `false` lo deshabilita aunque lo traiga y `null` vuelve a lo del plan. Con `expiresAt`, la excepción deja de regir sola. Idempotente. Apagar no borra nada: deja de crear lo nuevo y lo que está en curso termina (`impact` dice cuánto queda). Rige en la request siguiente (la caché del acceso se invalida); la empresa recibe un aviso en su bandeja y el cambio queda en la auditoría con el administrador general como actor. Otra empresa no cambia.',
  })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiParam({ name: 'key', enum: MODULOS })
  @ApiOkResponse({ type: CompanyModuleDto })
  @ApiBadRequestResponse({
    description: `${ID_INVALIDO}; módulo que no existe (\`MODULE_UNKNOWN\`); falta \`enabled\` o no es booleano ni null; motivo de menos de 10 o más de 300 caracteres; vencimiento que no es una fecha ISO 8601, que ya pasó o que acompaña a \`enabled: null\``,
  })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  set(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() dto: SetCompanyModuleDto,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<CompanyModuleDto> {
    return this.modulos.cambiar(id, key, dto, actorUserId);
  }
}
