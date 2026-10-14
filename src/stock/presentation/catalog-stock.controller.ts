import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../../common/decorators/auth.decorator';
import { RoleType } from '../../common/constants/role-type.enum';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { exigirIdempotencyKey } from './exigir-idempotency-key';
import { IdempotencyKeyObligatoria } from './idempotency-key-obligatoria.decorator';
import { GasCylinderResponseDto } from '../../gascylinder/dto/gascylinder-response.dto';
import { UpdateStockDto } from '../../gascylinder/dto/update-stock.dto';
import { GasCylinderMapper } from '../../gascylinder/gascylinder.mapper';
import { GasCylinderPhotoService } from '../../gascylinder/gascylinder-photo.service';
import { CatalogStockAdjustmentUseCase } from '../application/catalog-stock-adjustment.use-case';

/**
 * `PATCH /gascylinder/:id/stock`: la ruta de siempre del catálogo, que desde el
 * módulo de stock crea un ajuste `count_correction` de llenas en el depósito
 * predeterminado. Misma ruta y mismo contrato; vive acá porque `gascylinder`
 * no puede depender de `stock` (stock usa su servicio de vendible).
 */
@ApiTags('Gas Cylinders')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('gascylinder')
export class CatalogStockController {
  constructor(
    private readonly adjustment: CatalogStockAdjustmentUseCase,
    private readonly photos: GasCylinderPhotoService,
  ) {}

  @Patch(':id/stock')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Update gas cylinder stock',
    description:
      '**Exige** `Idempotency-Key` (400 sin ella): suma y resta son relativas, un reintento sin clave ajustaría dos veces. ' +
      'Suma (positivo) o resta (negativo) llenas en el depósito predeterminado ' +
      'como un ajuste de conteo: deja el rastro en el libro de stock y mantiene ' +
      'el vendible igual al físico menos lo reservado.\n\n' +
      '**Cambio de contrato:** al restar, si el depósito predeterminado no tiene tantas llenas ' +
      'responde 400 con un mensaje que dice dónde están las demás (camiones u otros depósitos) ' +
      'y cómo ajustarlas ahí; antes sólo comparaba contra el vendible.',
  })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiOkResponse({ type: GasCylinderResponseDto })
  @ApiBadRequestResponse({
    description:
      'El stock quedaría negativo: vendible, o llenas del depósito predeterminado (el mensaje indica dónde está el resto)',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async updateStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStockDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<GasCylinderResponseDto> {
    exigirIdempotencyKey(idempotencyKey, 'El ajuste de stock del catálogo');
    const producto = await this.adjustment.execute(
      id,
      dto.quantity,
      distributorId,
      actorUserId,
    );
    await this.photos.firmar(producto);
    return GasCylinderMapper.toDto(producto);
  }
}
