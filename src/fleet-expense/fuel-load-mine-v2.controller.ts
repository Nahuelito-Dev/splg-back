import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { importeEsperado } from './domain/fuel-consumption';
import {
  CotizacionDeCargaPropiaDto,
  CotizarCargaPropiaDto,
  IMPORTE_MAXIMO_DE_CARGA,
} from './dto/fuel-load-quote-mine.dto';

/** El importe de la carga que registra el chofer, calculado por el back (API v2). */
@ApiTags('Fleet · Combustible (v2)')
@Auth(RoleType.DELIVERY)
@Controller({ path: 'fleet/fuel-loads/mine', version: '2' })
export class FuelLoadMineV2Controller {
  @Get('quote')
  @ApiOperation({
    summary: 'Calcular el importe de la carga del chofer',
    description:
      'Litros × precio por litro a 2 decimales: la misma cuenta con la que `POST /fleet/fuel-loads/mine` valida el importe. La app lo muestra y lo manda como `totalAmount`.',
  })
  @ApiOkResponse({ type: CotizacionDeCargaPropiaDto })
  @ApiBadRequestResponse({
    description: 'Litros o precio inválidos, o importe por encima del máximo',
  })
  quote(@Query() query: CotizarCargaPropiaDto): CotizacionDeCargaPropiaDto {
    const totalAmount = importeEsperado(query.liters, query.unitPrice);
    if (totalAmount > IMPORTE_MAXIMO_DE_CARGA) {
      throw new BadRequestException(
        'El importe supera el máximo permitido para una carga',
      );
    }
    return {
      liters: query.liters,
      unitPrice: query.unitPrice,
      totalAmount,
    };
  }
}
