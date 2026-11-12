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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../../common/decorators/auth.decorator';
import { RoleType } from '../../common/constants/role-type.enum';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { MessageResponseDto } from '../../common/dtos/message-response.dto';
import { WarehouseService } from '../application/warehouse.service';
import { StockQueryService } from '../application/stock-query.service';
import {
  CreateWarehouseDto,
  QueryWarehouseDto,
  UpdateWarehouseDto,
  WarehouseDetailDto,
  WarehouseResponseDto,
} from '../dto/warehouse.dto';
import { WarehouseMapper } from './warehouse.mapper';

/**
 * Depósitos de la distribuidora (CU-207). Baja lógica: se da de baja sólo sin
 * saldo y si no es el predeterminado.
 */
@ApiTags('Stock · Depósitos')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('warehouses')
export class WarehouseController {
  constructor(
    private readonly warehouses: WarehouseService,
    private readonly query: StockQueryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar los depósitos de la distribuidora' })
  @ApiOkResponse({ type: WarehouseResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Filtros inválidos o falta la distribuidora',
  })
  async findAll(
    @Query() query: QueryWarehouseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseResponseDto[]> {
    const depositos = await this.warehouses.findAll(distributorId, query);
    return depositos.map((d) => WarehouseMapper.toDto(d));
  }

  @Post()
  @ApiOperation({ summary: 'Crear un depósito' })
  @ApiCreatedResponse({ type: WarehouseResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({
    description: 'Ya hay un depósito vigente con ese código',
  })
  async create(
    @Body() dto: CreateWarehouseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseResponseDto> {
    return WarehouseMapper.toDto(
      await this.warehouses.create(dto, distributorId),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver un depósito con sus saldos' })
  @ApiParam({ name: 'id', description: 'Depósito UUID' })
  @ApiOkResponse({ type: WarehouseDetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({
    description: 'El identificador no es válido o falta la distribuidora',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseDetailDto> {
    const deposito = await this.warehouses.findOne(id, distributorId);
    const balances = await this.query.saldos(distributorId, {
      warehouseId: id,
    });
    return WarehouseMapper.toDetailDto(deposito, balances);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar un depósito o cambiar el predeterminado' })
  @ApiParam({ name: 'id', description: 'Depósito UUID' })
  @ApiOkResponse({ type: WarehouseResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({
    description: 'Datos o identificador inválidos, o falta la distribuidora',
  })
  @ApiConflictResponse({
    description:
      'Código repetido, o se intenta sacar la marca / desactivar el predeterminado',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseResponseDto> {
    return WarehouseMapper.toDto(
      await this.warehouses.update(id, dto, distributorId),
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Dar de baja un depósito (baja lógica)' })
  @ApiParam({ name: 'id', description: 'Depósito UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({
    description: 'El identificador no es válido o falta la distribuidora',
  })
  @ApiConflictResponse({
    description: 'Es el predeterminado o todavía tiene garrafas',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MessageResponseDto> {
    await this.warehouses.remove(id, distributorId);
    return MessageResponseDto.of('Depósito dado de baja');
  }
}
