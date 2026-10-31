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
import { Public } from '../common/decorators/isPublic.decorator';
import { GasCylinderService } from './gascylinder.service';
import { GasCylinderPhotoService } from './gascylinder-photo.service';
import { CatalogoPublicoDto } from './dto/catalogo-publico.dto';
import { GasCylinderMapper } from './gascylinder.mapper';

/** Lo que un visitante sin sesión puede ver de una distribuidora. */
@ApiTags('Gas Cylinders')
@Controller({ path: 'public/distributors', version: '2' })
export class PublicCatalogController {
  constructor(
    private readonly gasCylinderService: GasCylinderService,
    private readonly gasCylinderPhoto: GasCylinderPhotoService,
  ) {}

  @Public()
  @Get(':slug/catalog')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Catálogo de una distribuidora, sin iniciar sesión',
    description:
      'Público. Los productos activos de la distribuidora con lo que puede ver un visitante: ' +
      'tipo, peso, precio de lista, descripción, foto (URL firmada de lectura corta), ' +
      'promociones por cantidad y si hay stock (`inStock`, sin la cantidad). ' +
      'No expone costos, stock exacto ni datos internos.',
  })
  @ApiParam({ name: 'slug', example: 'demo' })
  @ApiOkResponse({ type: CatalogoPublicoDto })
  @ApiNotFoundResponse({
    description: 'La distribuidora no existe o no está activa',
  })
  @ApiTooManyRequestsResponse({ description: 'Demasiados pedidos seguidos' })
  async catalogo(@Param('slug') slug: string): Promise<CatalogoPublicoDto> {
    const { distributor, products } =
      await this.gasCylinderService.catalogoPublico(slug);
    await this.gasCylinderPhoto.firmar(products);
    return {
      slug: distributor.slug,
      name: distributor.name,
      products: products.map((g) => GasCylinderMapper.toPublicDto(g)),
    };
  }
}
