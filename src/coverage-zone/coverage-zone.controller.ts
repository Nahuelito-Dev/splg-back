import type { Response } from 'express';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiBadRequestResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { CoverageZoneService } from './coverage-zone.service';
import { CoverageZoneMapper } from './coverage-zone.mapper';
import {
  CoverageCheckResponseDto,
  CoverageZoneResponseDto,
} from './dto/coverage-zone-response.dto';
import { CreateCoverageZoneDto } from './dto/create-coverage-zone.dto';
import { UpdateCoverageZoneDto } from './dto/update-coverage-zone.dto';
import { QueryCoverageZoneDto } from './dto/query-coverage-zone.dto';
import { CheckCoverageDto } from './dto/check-coverage.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { ApiTotal, informarTotal } from '../common/http/total';

const DATOS_INVALIDOS =
  'Datos inválidos (p. ej.: polygon must contain at least 3 elements; ' +
  'surchargeValue: un recargo porcentual tiene que estar entre 0 y 100; ' +
  'color: tiene que ser un hexadecimal de 6 dígitos, ej. #FF7A00)';

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
  @ApiBadRequestResponse({
    description:
      `${DATOS_INVALIDOS}, o un polígono que se autointersecta (400 con el ` +
      'motivo que da PostGIS)',
  })
  @ApiConflictResponse({
    description:
      'Ya hay una zona activa con ese nombre (sin distinguir mayúsculas) o con esa prioridad; sin prioridad en el alta se asigna la siguiente',
  })
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
    description:
      'Por default sólo las activas; `includeInactive=true` trae también las ' +
      'inactivas (nunca las borradas).',
  })
  @ApiOkResponse({ type: CoverageZoneResponseDto, isArray: true })
  @ApiTotal()
  async findAll(
    @Query() query: QueryCoverageZoneDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CoverageZoneResponseDto[]> {
    const [zones, total] = await this.coverageZoneService.findAll(
      distributorId,
      query.includeInactive,
    );
    informarTotal(res, total);
    return zones.map((z) => CoverageZoneMapper.toDto(z));
  }

  // Declarado ANTES de ':id': si no, Nest interpreta "check" como un :id y
  // ParseUUIDPipe lo rechaza con 400 en vez de resolver este endpoint.
  @Get('check')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Validar si una dirección está dentro de la cobertura (antes de pedir)',
    description:
      'La distribuidora se toma del header X-Distributor. Si la distribuidora ' +
      'no cargó zonas, se considera cubierta con recargo 0. `zoneId`, ' +
      '`zoneName` y `surcharge` se mantienen por compatibilidad; usar `zone` ' +
      '(y `amount`, si se mandó `subtotal`) en clientes nuevos.',
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
      dto.subtotal,
    );
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Ver una zona de cobertura' })
  @ApiParam({ name: 'id', description: 'Coverage zone UUID' })
  @ApiOkResponse({ type: CoverageZoneResponseDto })
  @ApiNotFoundResponse({
    description: 'La zona no existe o es de otra distribuidora',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CoverageZoneResponseDto> {
    return CoverageZoneMapper.toDto(
      await this.coverageZoneService.findOne(id, distributorId),
    );
  }

  @Patch(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Editar una zona de cobertura',
    description:
      'Nombre, polígono, tipo y valor del recargo, prioridad, vigencia, ' +
      'color, etiqueta o si está activa. La validación del recargo y de la ' +
      'vigencia corre sobre el estado ya fusionado con lo que no vino en el body.',
  })
  @ApiParam({ name: 'id', description: 'Coverage zone UUID' })
  @ApiOkResponse({ type: CoverageZoneResponseDto })
  @ApiNotFoundResponse({
    description: 'La zona no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description: `${DATOS_INVALIDOS}, o validUntil anterior o igual a validFrom`,
  })
  @ApiConflictResponse({
    description:
      'El nombre o la prioridad ya los tiene otra zona activa de la distribuidora',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCoverageZoneDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CoverageZoneResponseDto> {
    return CoverageZoneMapper.toDto(
      await this.coverageZoneService.update(id, dto, distributorId),
    );
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Eliminar una zona de cobertura (baja lógica)' })
  @ApiParam({ name: 'id', description: 'Coverage zone UUID' })
  @HttpCode(HttpStatus.OK)
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
