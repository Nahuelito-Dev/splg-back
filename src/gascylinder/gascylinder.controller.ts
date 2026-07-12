// src/gascylinder/gascylinder.controller.ts - VERSIÓN CORREGIDA
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { GasCylinderService } from './gascylinder.service';
import { Public } from '../common/decorators/isPublic.decorator';
import { CreateGasCylinderDto } from './dto/create-gascylinder.dto';
import { UpdateGasCylinderDto } from './dto/update-gascylinder.dto';
import { CatalogQueryDto } from './dto/catalog-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Gas Cylinders')
@Controller('gascylinder')
export class GasCylinderController {
  constructor(private readonly gasCylinderService: GasCylinderService) {}

  @Post()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new gas cylinder type' })
  @ApiResponse({
    status: 201,
    description: 'Gas cylinder created successfully',
  })
  create(
    @Body() createGasCylinderDto: CreateGasCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.gasCylinderService.create(createGasCylinderDto, distributorId);
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Get all gas cylinders with pagination' })
  @ApiResponse({ status: 200, description: 'List of gas cylinders' })
  findAll(@Query() query: CatalogQueryDto) {
    return this.gasCylinderService.findAll(query, query.distributor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get gas cylinder by ID' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiResponse({ status: 200, description: 'Gas cylinder found' })
  @ApiResponse({ status: 404, description: 'Gas cylinder not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.gasCylinderService.findOne(id);
  }

  @Get('type/:type')
  @ApiOperation({ summary: 'Get gas cylinder by type' })
  @ApiParam({
    name: 'type',
    description: 'Gas cylinder type (10kg, 15kg, etc)',
  })
  @ApiResponse({ status: 200, description: 'Gas cylinder found' })
  findByType(
    @Param('type') type: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.gasCylinderService.findByType(type, distributorId ?? undefined);
  }

  @Get('available/list')
  @Public()
  @ApiOperation({ summary: 'Get all available gas cylinders' })
  @ApiResponse({ status: 200, description: 'List of available gas cylinders' })
  getAvailableCylinders(@Query('distributor') distributor?: string) {
    return this.gasCylinderService.getAvailableCylinders(distributor);
  }

  @Patch(':id')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update gas cylinder by ID' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiResponse({
    status: 200,
    description: 'Gas cylinder updated successfully',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateGasCylinderDto: UpdateGasCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.gasCylinderService.update(
      id,
      updateGasCylinderDto,
      distributorId,
    );
  }

  @Patch(':id/stock')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update gas cylinder stock' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiResponse({ status: 200, description: 'Stock updated successfully' })
  updateStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { quantity: number },
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.gasCylinderService.updateStock(id, body.quantity, distributorId);
  }

  @Delete(':id')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete (deactivate) gas cylinder by ID' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiResponse({
    status: 200,
    description: 'Gas cylinder deactivated successfully',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.gasCylinderService.remove(id, distributorId);
  }
}
