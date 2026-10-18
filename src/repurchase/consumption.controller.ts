import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { ConsumptionService } from './consumption.service';
import { ConsumptionMapper } from './consumption.mapper';
import { UpdateConsumptionDto } from './dto/update-consumption.dto';
import { ConsumptionResponseDto } from './dto/consumption-response.dto';

/**
 * El consumo promedio declarado del cliente autenticado (CU-143 y CU-144). La
 * declaración inicial viaja en el registro (`consumption` en
 * `POST /auth/registro`); acá se consulta y se corrige.
 */
@ApiTags('Customers')
@Auth(RoleType.CUSTOMER)
@Controller('customers/me/consumption')
export class ConsumptionController {
  constructor(private readonly consumption: ConsumptionService) {}

  @Get()
  @ApiOperation({
    summary: 'Consumo declarado y recompra estimada del cliente',
  })
  @ApiOkResponse({ type: ConsumptionResponseDto })
  @ApiNotFoundResponse({ description: 'El usuario no tiene ficha de cliente' })
  async obtener(
    @CurrentUser('user_id') userId: string,
  ): Promise<ConsumptionResponseDto> {
    return ConsumptionMapper.toDto(await this.consumption.obtener(userId));
  }

  @Patch()
  @ApiOperation({
    summary: 'Modificar el consumo promedio declarado (CU-144)',
    description:
      'Convierte la declaración a kg por mes con el peso del tipo de garrafa, valida el rango (5 a 500 kg por mes) y recalcula la fecha estimada de recompra desde la última compra entregada (o desde ahora si nunca compró). Fuera de rango responde 400 y pide confirmar con `confirmOutOfRange: true`.',
  })
  @ApiOkResponse({ type: ConsumptionResponseDto })
  @ApiBadRequestResponse({
    description:
      'Valor fuera de rango sin confirmar, tipo de garrafa inexistente o dado de baja, o falta el tipo de garrafa habitual',
  })
  @ApiNotFoundResponse({ description: 'El usuario no tiene ficha de cliente' })
  async actualizar(
    @Body() dto: UpdateConsumptionDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ConsumptionResponseDto> {
    return ConsumptionMapper.toDto(
      await this.consumption.actualizar(userId, dto, distributorId),
    );
  }
}
