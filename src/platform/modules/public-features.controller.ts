import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/isPublic.decorator';
import { CompanyModulesService } from './company-modules.service';
import { PublicFeaturesDto } from './dto/modules.dto';

/** Lo que una app sin sesión puede saber de los módulos de una distribuidora (§5.3). */
@ApiTags('Gas Cylinders')
@Controller({ path: 'public/distributors', version: '2' })
export class PublicFeaturesController {
  constructor(private readonly modulos: CompanyModulesService) {}

  @Public()
  @Get(':slug/features')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Módulos en uso de una distribuidora, sin iniciar sesión',
    description:
      'Público. Los módulos habilitados y encendidos de la distribuidora (para que la app esconda lo que no está), si toma pedidos y, si no, el texto para mostrar. Una distribuidora suspendida responde 200 con `acceptingOrders: false` y sin módulos.',
  })
  @ApiParam({ name: 'slug', example: 'demo' })
  @ApiOkResponse({ type: PublicFeaturesDto })
  @ApiNotFoundResponse({
    description: 'La distribuidora no existe o está dada de baja',
  })
  @ApiTooManyRequestsResponse({ description: 'Demasiados pedidos seguidos' })
  features(@Param('slug') slug: string): Promise<PublicFeaturesDto> {
    return this.modulos.featuresPublicas(slug);
  }
}
