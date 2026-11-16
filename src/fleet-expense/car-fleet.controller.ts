import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CarCostDetailDto, FleetCostSummaryDto } from './dto/fleet-cost.dto';
import { FuelEfficiencyDto, QueryRangeDto } from './dto/fuel-load.dto';
import { QueryTireDto, TirePageDto } from './dto/tire.dto';
import { FleetCostService } from './fleet-cost.service';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { FuelLoadService } from './fuel-load.service';
import { TireService } from './tire.service';
import { Permiso } from '../common/decorators/permiso.decorator';

/** Lo que se consulta desde la ficha de un vehículo: rendimiento, costo y neumáticos. */
@ApiTags('Fleet · Costos')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller()
export class CarFleetController {
  constructor(
    private readonly fuel: FuelLoadService,
    private readonly costs: FleetCostService,
    private readonly tires: TireService,
  ) {}

  @Permiso('flota.ver')
  @Get('cars/:carId/fuel-efficiency')
  @ApiOperation({
    summary: 'Consumo de combustible de un vehículo',
    description:
      'Arma los tramos entre cargas de tanque lleno del rango y muestra, por tramo y en total, km, litros, km por litro, costo por km y las cargas anómalas. Con menos de dos cargas de tanque lleno: lista vacía y totales en cero.',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiOkResponse({ type: FuelEfficiencyDto })
  @ApiBadRequestResponse({
    description: 'Fecha inválida o inicio posterior al fin',
  })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  consumo(
    @Param('carId', ParseUUIDPipe) carId: string,
    @Query() query: QueryRangeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FuelEfficiencyDto> {
    return this.fuel.consumo(carId, distributorId, query.from, query.to);
  }

  @Permiso('flota.ver')
  @Get('cars/:carId/costs')
  @ApiOperation({
    summary: 'Costo total de un vehículo',
    description:
      'Suma mantenimiento (sin seguros), seguros prorrateados por días, combustible, multas pagadas no imputadas y siniestros cerrados; con km, costo por km y evolución mensual.',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiOkResponse({ type: CarCostDetailDto })
  @ApiBadRequestResponse({
    description: 'Fecha inválida o inicio posterior al fin',
  })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  costoDelVehiculo(
    @Param('carId', ParseUUIDPipe) carId: string,
    @Query() query: QueryRangeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarCostDetailDto> {
    return this.costs.costoDelVehiculo(
      carId,
      distributorId,
      query.from,
      query.to,
    );
  }

  @Permiso('flota.ver')
  @Get('fleet/costs')
  @ApiOperation({
    summary: 'Tablero de costos de la flota',
    description:
      'Un renglón por vehículo con los rubros del costo total, km y costo por km, de mayor a menor costo por km. Un vehículo sin km va al final.',
  })
  @ApiOkResponse({ type: FleetCostSummaryDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Fecha inválida o inicio posterior al fin',
  })
  tablero(
    @Query() query: QueryRangeDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetCostSummaryDto[]> {
    return this.costs.tablero(distributorId, query.from, query.to);
  }

  @Permiso('flota.ver')
  @Get('cars/:carId/tires')
  @ApiOperation({ summary: 'Neumáticos de un vehículo' })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiOkResponse({ type: TirePageDto })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  async neumaticos(
    @Param('carId', ParseUUIDPipe) carId: string,
    @Query() query: QueryTireDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TirePageDto> {
    const { data, total } = await this.tires.delVehiculo(
      carId,
      distributorId,
      query,
    );
    return { data: data.map((t) => FleetExpenseMapper.tire(t)), total };
  }
}
