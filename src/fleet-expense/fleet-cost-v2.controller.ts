import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { FleetCostBoardDto } from './dto/fleet-cost.dto';
import { QueryRangeDto } from './dto/fuel-load.dto';
import { FleetCostService } from './fleet-cost.service';
import { Permiso } from '../common/decorators/permiso.decorator';

/** El tablero de costos con sus totales (API v2; el v1 devuelve sólo la lista de vehículos). */
@ApiTags('Fleet · Costos (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'fleet/costs', version: '2' })
export class FleetCostV2Controller {
  constructor(private readonly costs: FleetCostService) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({
    summary: 'Tablero de costos de la flota, con sus totales',
    description:
      'Los mismos renglones por vehículo que la v1 (de mayor a menor costo por km; sin km, al final) dentro de `vehicles`, y en `summary` los totales de la flota por rubro, el costo total, los km y el costo por km, que sólo cuenta los vehículos con km (`withoutKm` los informa aparte).',
  })
  @ApiOkResponse({ type: FleetCostBoardDto })
  @ApiBadRequestResponse({
    description: 'Fecha inválida o inicio posterior al fin',
  })
  tablero(
    @Query() query: QueryRangeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetCostBoardDto> {
    return this.costs.tableroConResumen(distributorId, query.from, query.to);
  }
}
