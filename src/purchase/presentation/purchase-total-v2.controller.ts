import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { totalDe } from '../domain/purchase-rules';
import {
  PreviewPurchaseTotalDto,
  PurchaseTotalPreviewDto,
} from '../dto/purchase-total-preview.dto';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** El total de una compra tal como lo guarda el back (API v2). No escribe nada. */
@ApiTags('Compras · Total (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'purchase-orders', version: '2' })
export class PurchaseTotalV2Controller {
  @Permiso('compras.gestionar')
  @Post('preview-total')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Calcular el total de una orden o remito de compra',
    description:
      'Σ cantidad × costo unitario con aritmética decimal, a 2 decimales: la misma cuenta con la que se guardan la orden y el remito. Es una vista previa para el formulario: no guarda nada.',
  })
  @ApiOkResponse({ type: PurchaseTotalPreviewDto })
  @ApiBadRequestResponse({
    description: 'Renglón inválido o total por encima del máximo',
  })
  previewTotal(@Body() dto: PreviewPurchaseTotalDto): PurchaseTotalPreviewDto {
    return {
      items: dto.items.map((i) => ({ subtotal: totalDe([i]) })),
      total: totalDe(dto.items),
    };
  }
}
