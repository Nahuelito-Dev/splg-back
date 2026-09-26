import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { DistributorMapper } from './distributor.mapper';
import { DistributorResponseDto } from './dto/distributor-response.dto';
import { DistributorService } from './distributor.service';
import { CreateDistributorDto } from './dto/create-distributor.dto';
import { UpdateDistributorDto } from './dto/update-distributor.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Gestión de distribuidoras (tenants). Es una operación de PLATAFORMA:
 * sólo el super_admin puede crear/editar/borrar tenants. Un admin de
 * distribuidora nunca administra otras distribuidoras.
 */
@ApiTags('Distributors')
@ApiBearerAuth()
@Auth(RoleType.SUPER_ADMIN)
@Controller('distributor')
export class DistributorController {
  constructor(private readonly distributorService: DistributorService) {}

  @Post()
  @ApiOperation({ summary: 'Crear una distribuidora (tenant)' })
  @ApiCreatedResponse({ type: DistributorResponseDto })
  @ApiConflictResponse({ description: 'slug duplicado' })
  async create(
    @Body() dto: CreateDistributorDto,
  ): Promise<DistributorResponseDto> {
    return DistributorMapper.toDto(await this.distributorService.create(dto));
  }

  @Get()
  @ApiOperation({ summary: 'Listar todas las distribuidoras' })
  @ApiOkResponse({ type: DistributorResponseDto, isArray: true })
  async findAll(): Promise<DistributorResponseDto[]> {
    const all = await this.distributorService.findAll();
    return all.map((d) => DistributorMapper.toDto(d));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener distribuidora por ID' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ type: DistributorResponseDto })
  @ApiNotFoundResponse({ description: 'La distribuidora no existe' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DistributorResponseDto> {
    return DistributorMapper.toDto(await this.distributorService.findOne(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar distribuidora' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ type: DistributorResponseDto })
  @ApiNotFoundResponse({ description: 'La distribuidora no existe' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDistributorDto,
  ): Promise<DistributorResponseDto> {
    return DistributorMapper.toDto(
      await this.distributorService.update(id, dto),
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar (soft) distribuidora' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ description: 'Sin cuerpo' })
  @ApiNotFoundResponse({ description: 'La distribuidora no existe' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.distributorService.remove(id);
  }
}
