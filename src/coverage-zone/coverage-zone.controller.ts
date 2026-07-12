import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CoverageZoneService } from './coverage-zone.service';
import { CreateCoverageZoneDto } from './dto/create-coverage-zone.dto';
import { CheckCoverageDto } from './dto/check-coverage.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Coverage Zones')
@ApiBearerAuth()
@Controller('coverage-zones')
export class CoverageZoneController {
  constructor(private readonly coverageZoneService: CoverageZoneService) {}

  @Post()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Crear una zona de cobertura (polígono) de la distribuidora' })
  @ApiResponse({ status: 201, description: 'Zona creada' })
  create(
    @Body() dto: CreateCoverageZoneDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.coverageZoneService.create(dto, distributorId);
  }

  @Get()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Listar las zonas de cobertura de la distribuidora' })
  findAll(@CurrentDistributor({ required: true }) distributorId: string) {
    return this.coverageZoneService.findAll(distributorId);
  }

  @Get('check')
  @Roles(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Validar si una dirección está dentro de la cobertura (antes de pedir)',
    description:
      'Devuelve { covered, zoneId, zoneName, surcharge }. La distribuidora se ' +
      'toma del header X-Distributor. Si la distribuidora no cargó zonas, se ' +
      'considera cubierta con recargo 0.',
  })
  @ApiResponse({ status: 200, description: 'Resultado de cobertura' })
  check(
    @Query() dto: CheckCoverageDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.coverageZoneService.checkCoverage(distributorId, dto.lat, dto.lng);
  }

  @Delete(':id')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Eliminar una zona de cobertura' })
  @ApiParam({ name: 'id', description: 'Coverage zone UUID' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.coverageZoneService.remove(id, distributorId);
  }
}
