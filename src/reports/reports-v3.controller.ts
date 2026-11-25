import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { VehicleUtilizationQueryDto } from './dto/report-range-query.dto';
import { VehicleUtilizationReportDto } from './dto/vehicle-utilization-response.dto';
import { rangoDelInforme } from './rango-del-informe';
import { ReportsService } from './reports.service';
import { MAXIMO_DE_DIAS_DEL_RANGO } from '../fleet-expense/domain/vehicle-cost';
import { rangoDeDias } from '../fleet-expense/domain/rango';

@ApiTags('Reports (v3)')
@ApiBearerAuth()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'reports', version: '3' })
export class ReportsV3Controller {
  constructor(private readonly reports: ReportsService) {}

  @Permiso('flota.ver')
  @Get('vehicle-utilization')
  @ApiOperation({
    summary: 'Utilización y costos por vehículo',
    description:
      'Días con uso, kilómetros, entregas y costos del vehículo. El rango usa días argentinos y `to` es inclusivo.',
  })
  @ApiOkResponse({ type: VehicleUtilizationReportDto })
  @ApiBadRequestResponse({
    description:
      'Fecha inválida, rango invertido o superior al máximo permitido',
  })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  utilization(
    @Query() query: VehicleUtilizationQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleUtilizationReportDto> {
    const range = rangoDelInforme(query.from, query.to);
    try {
      rangoDeDias(range.from, range.to, MAXIMO_DE_DIAS_DEL_RANGO);
    } catch {
      throw new BadRequestException({
        code: 'DATE_RANGE_TOO_LARGE',
        message: `El rango no puede superar ${MAXIMO_DE_DIAS_DEL_RANGO} días`,
      });
    }
    return this.reports.getVehicleUtilization(
      range,
      distributorId,
      query.vehicleId,
    );
  }
}
