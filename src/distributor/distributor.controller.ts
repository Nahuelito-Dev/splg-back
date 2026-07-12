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
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { DistributorService } from './distributor.service';
import { CreateDistributorDto } from './dto/create-distributor.dto';
import { UpdateDistributorDto } from './dto/update-distributor.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';

/**
 * Gestión de distribuidoras (tenants). Es una operación de PLATAFORMA:
 * sólo el super_admin puede crear/editar/borrar tenants. Un admin de
 * distribuidora nunca administra otras distribuidoras.
 */
@ApiTags('Distributors')
@ApiBearerAuth()
@Roles(RoleType.SUPER_ADMIN)
@Controller('distributor')
export class DistributorController {
  constructor(private readonly distributorService: DistributorService) {}

  @Post()
  @ApiOperation({ summary: 'Crear una distribuidora (tenant)' })
  @ApiResponse({ status: 201, description: 'Distribuidora creada' })
  @ApiResponse({ status: 409, description: 'slug duplicado' })
  create(@Body() dto: CreateDistributorDto) {
    return this.distributorService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar todas las distribuidoras' })
  findAll() {
    return this.distributorService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener distribuidora por ID' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.distributorService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar distribuidora' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDistributorDto,
  ) {
    return this.distributorService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar (soft) distribuidora' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.distributorService.remove(id);
  }
}
