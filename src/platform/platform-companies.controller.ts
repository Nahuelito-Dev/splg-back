import { Body, Controller, Param, ParseUUIDPipe, Put } from '@nestjs/common';
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
import { SinDistribuidora } from '../common/decorators/sin-distribuidora.decorator';
import { DistributorService } from '../distributor/distributor.service';
import type { Distributor } from '../distributor/entities/distributor.entity';
import {
  PlatformCompanyDto,
  SetOwnedByPlatformDto,
} from './dto/platform-companies.dto';

/** La empresa como la ve la plataforma: sin datos bancarios ni credenciales. */
export function aEmpresaDePlataforma(d: Distributor): PlatformCompanyDto {
  return {
    id: d.distributorId,
    name: d.name,
    slug: d.slug,
    status: d.status,
    ownedByPlatform: d.ownedByPlatform,
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Las empresas de la plataforma (API v2, sólo `super_admin`, alcance
 * `plataforma`). `@SinDistribuidora()`: no leen `X-Distributor` ni
 * `X-Support-Session`.
 */
@ApiTags('Platform')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/companies', version: '2' })
export class PlatformCompaniesController {
  constructor(private readonly distribuidoras: DistributorService) {}

  @Put(':id/owned-by-platform')
  @ApiOperation({
    summary: 'Marcar o desmarcar una empresa como propia de la plataforma',
    description:
      'Una empresa propia (de prueba) la opera el administrador general directo, con lectura y escritura, mandando su slug o id en `X-Distributor`, sin sesión de soporte; las demás siguen exigiendo el modo soporte. Idempotente. El cambio queda en la auditoría con el administrador general como actor; desmarcarla corta el acceso directo en la request siguiente.',
  })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ type: PlatformCompanyDto })
  @ApiBadRequestResponse({
    description:
      'El id no es un UUID, o falta `ownedByPlatform` o no es booleano',
  })
  @ApiNotFoundResponse({
    description: 'La empresa no existe o está dada de baja',
  })
  @ApiConflictResponse({
    description:
      'Sólo se puede marcar una empresa de prueba creada por la plataforma, sin admins, clientes ni pedidos ajenos (`COMPANY_NOT_PLATFORM_OWNED`). Desmarcar siempre está permitido.',
  })
  async marcar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOwnedByPlatformDto,
  ): Promise<PlatformCompanyDto> {
    return aEmpresaDePlataforma(
      await this.distribuidoras.marcarPropia(id, dto.ownedByPlatform),
    );
  }
}
