import { Controller, Get } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import {
  CurrentDistributor,
  MENSAJE_FALTA_DISTRIBUIDORA,
} from '../../common/decorators/current-distributor.decorator';
import { CompanyModulesService } from './company-modules.service';
import { FeaturesDto, OwnModuleDto } from './dto/modules.dto';

/**
 * Los módulos de la propia empresa (DISENO-PLATAFORMA-ORIXTECH §5.3). El
 * tenant sale del perfil (admin), de la sesión de soporte o de la empresa
 * propia: ningún parámetro acepta otra distribuidora.
 */
@ApiTags('Company')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'company/modules', version: '2' })
export class CompanyModulesController {
  constructor(private readonly modulos: CompanyModulesService) {}

  @Get()
  @ApiOperation({
    summary: 'Los módulos de mi empresa',
    description:
      'Cada módulo del catálogo con si la plataforma se lo habilitó a la empresa (`enabled`) y si está en uso (`effective`: habilitado y encendido por la empresa). Cualquier administrador de la empresa lo puede ver.',
  })
  @ApiOkResponse({ type: OwnModuleDto, isArray: true })
  @ApiBadRequestResponse({
    description: `${MENSAJE_FALTA_DISTRIBUIDORA} (\`MISSING_DISTRIBUTOR\`)`,
  })
  list(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<OwnModuleDto[]> {
    return this.modulos.deLaEmpresa(distributorId);
  }
}

/** Lo que pueden usar el panel y las apps en la empresa de la sesión (§5.3). */
@ApiTags('Company')
@Auth(
  RoleType.ADMIN,
  RoleType.SUPER_ADMIN,
  RoleType.DELIVERY,
  RoleType.CUSTOMER,
)
@Controller({ path: 'me/features', version: '2' })
export class MeFeaturesController {
  constructor(private readonly modulos: CompanyModulesService) {}

  @Get()
  @ApiOperation({
    summary: 'Módulos en uso en mi distribuidora',
    description:
      'Los módulos habilitados y encendidos de la distribuidora de la sesión (la del perfil del admin o del chofer, la de `X-Distributor` del cliente) y el nivel de acceso. Las apps lo leen al iniciar y al volver a primer plano para esconder lo que no está; igual el back es la autoridad (`MODULE_DISABLED`).',
  })
  @ApiOkResponse({ type: FeaturesDto })
  @ApiBadRequestResponse({
    description: `Cliente sin \`X-Distributor\`: ${MENSAJE_FALTA_DISTRIBUIDORA} (\`MISSING_DISTRIBUTOR\`)`,
  })
  features(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FeaturesDto> {
    return this.modulos.features(distributorId);
  }
}
