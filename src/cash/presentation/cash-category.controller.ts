import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CashCategoryService } from '../application/cash-category.service';
import { CashMapper } from '../cash.mapper';
import {
  CashCategoryPageDto,
  CashCategoryResponseDto,
  CreateCashCategoryDto,
  QueryCashCategoryDto,
  UpdateCashCategoryDto,
} from '../dto/cash-category.dto';

/** Categorías de ingresos y gastos (CU-230, CU-265). */
@ApiTags('Finanzas · Categorías de caja')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('cash-categories')
export class CashCategoryController {
  constructor(private readonly categorias: CashCategoryService) {}

  @Get()
  @ApiOperation({ summary: 'Listar las categorías de ingresos y gastos' })
  @ApiOkResponse({ type: CashCategoryPageDto })
  async findAll(
    @Query() query: QueryCashCategoryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashCategoryPageDto> {
    const { data, total } = await this.categorias.findAll(distributorId, query);
    return { data: data.map((c) => CashMapper.categoria(c)), total };
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Crear una categoría de ingresos o gastos' })
  @ApiCreatedResponse({ type: CashCategoryResponseDto })
  @ApiConflictResponse({
    description: 'Ya hay una categoría activa con ese nombre y sentido',
  })
  async create(
    @Body() dto: CreateCashCategoryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashCategoryResponseDto> {
    return CashMapper.categoria(
      await this.categorias.create(dto, distributorId),
    );
  }

  @Patch(':id')
  @Idempotent()
  @ApiOperation({ summary: 'Renombrar o activar/desactivar una categoría' })
  @ApiParam({ name: 'id', description: 'Categoría UUID' })
  @ApiOkResponse({ type: CashCategoryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'Es una categoría de sistema, o el nombre ya está en uso',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCashCategoryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashCategoryResponseDto> {
    return CashMapper.categoria(
      await this.categorias.update(id, dto, distributorId),
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Desactivar una categoría',
    description:
      'Es la misma operación que `PATCH` con `isActive: false`: la categoría queda en los movimientos ya asentados.',
  })
  @ApiParam({ name: 'id', description: 'Categoría UUID' })
  @ApiOkResponse({ type: CashCategoryResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'Es una categoría de sistema' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashCategoryResponseDto> {
    return CashMapper.categoria(
      await this.categorias.deactivate(id, distributorId),
    );
  }
}
