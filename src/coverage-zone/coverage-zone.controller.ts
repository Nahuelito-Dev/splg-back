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
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CoverageZoneService } from './coverage-zone.service';
import { CoverageZoneMapper } from './coverage-zone.mapper';
import {
  CoverageCheckResponseDto,
  CoverageZoneResponseDto,
} from './dto/coverage-zone-response.dto';
import { CreateCoverageZoneDto } from './dto/create-coverage-zone.dto';
import { CheckCoverageDto } from './dto/check-coverage.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Coverage Zones')
@ApiBearerAuth()
@Controller('coverage-zones')
export class CoverageZoneController {
  constructor(private readonly coverageZoneService: CoverageZoneService) {}

  @Post()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Crear una zona de cobertura (polígono) de la distribuidora',
  })
  @ApiCreatedResponse({ type: CoverageZoneResponseDto })
  async create(
    @Body() dto: CreateCoverageZoneDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CoverageZoneResponseDto> {
    return CoverageZoneMapper.toDto(
      await this.coverageZoneService.create(dto, distributorId),
    );
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Listar las zonas de cobertura de la distribuidora',
  })
  @ApiOkResponse({ type: CoverageZoneResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CoverageZoneResponseDto[]> {
    const zones = await this.coverageZoneService.findAll(distributorId);
    return zones.map((z) => CoverageZoneMapper.toDto(z));
  }

  @Get('check')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Validar si una dirección está dentro de la cobertura (antes de pedir)',
    description:
      'Devuelve { covered, zoneId, zoneName, surcharge }. La distribuidora se ' +
      'toma del header X-Distributor. Si la distribuidora no cargó zonas, se ' +
      'considera cubierta con recargo 0.',
  })
  @ApiOkResponse({ type: CoverageCheckResponseDto })
  check(
    @Query() dto: CheckCoverageDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CoverageCheckResponseDto> {
    return this.coverageZoneService.checkCoverage(
      distributorId,
      dto.lat,
      dto.lng,
    );
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Eliminar una zona de cobertura' })
  @ApiParam({ name: 'id', description: 'Coverage zone UUID' })
  @ApiOkResponse({ description: 'Sin cuerpo' })
  @ApiNotFoundResponse({
    description: 'La zona no existe o es de otra distribuidora',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<void> {
    return this.coverageZoneService.remove(id, distributorId);
  }
}
