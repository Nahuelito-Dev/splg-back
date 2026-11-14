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
  Version,
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
  CreateWarehouseV2Dto,
  QueryWarehouseDto,
  UpdateWarehouseDto,
  UpdateWarehouseV2Dto,
  WarehouseDetailDto,
  WarehouseResponseDto,
  WarehouseV2DetailDto,
  WarehouseV2ResponseDto,
} from '../dto/warehouse.dto';
import { WarehouseMapper } from './warehouse.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

/**
 * Depósitos de la distribuidora (CU-207). Baja lógica: se da de baja sólo sin
 * saldo y si no es el predeterminado. La v2 suma la ubicación del depósito
 * (`latitude`/`longitude`), que es la salida de las hojas de ruta; la v1 queda
 * como estaba.
 */
const UBICACION =
  'La ubicación (`latitude` y `longitude`, juntas o ninguna) es el punto de salida de las hojas de ruta: sin ella la hoja avisa `no_warehouse` y sale del centro de las paradas. No se geocodifica la dirección.';

@ApiTags('Stock · Depósitos')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('warehouses')
export class WarehouseController {
  constructor(
    private readonly warehouses: WarehouseService,
    private readonly query: StockQueryService,
  ) {}

  @Permiso('stock.ver')
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

  @Permiso('stock.gestionar')
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

  @Permiso('stock.ver')
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

  @Permiso('stock.gestionar')
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

  @Permiso('stock.ver')
  @Get()
  @Version('2')
  @ApiOperation({
    summary: 'Listar los depósitos de la distribuidora, con su ubicación',
  })
  @ApiOkResponse({ type: WarehouseV2ResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Filtros inválidos o falta la distribuidora',
  })
  async findAllV2(
    @Query() query: QueryWarehouseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseV2ResponseDto[]> {
    const depositos = await this.warehouses.findAll(distributorId, query);
    return depositos.map((d) => WarehouseMapper.toV2Dto(d));
  }

  @Permiso('stock.gestionar')
  @Post()
  @Version('2')
  @ApiOperation({
    summary: 'Crear un depósito, con su ubicación',
    description: UBICACION,
  })
  @ApiCreatedResponse({ type: WarehouseV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos: latitud o longitud fuera de rango, una sola de las dos, o falta la distribuidora',
  })
  @ApiConflictResponse({
    description: 'Ya hay un depósito vigente con ese código',
  })
  async createV2(
    @Body() dto: CreateWarehouseV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseV2ResponseDto> {
    return WarehouseMapper.toV2Dto(
      await this.warehouses.create(dto, distributorId),
    );
  }

  @Permiso('stock.ver')
  @Get(':id')
  @Version('2')
  @ApiOperation({ summary: 'Ver un depósito con su ubicación y sus saldos' })
  @ApiParam({ name: 'id', description: 'Depósito UUID' })
  @ApiOkResponse({ type: WarehouseV2DetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({
    description: 'El identificador no es válido o falta la distribuidora',
  })
  async findOneV2(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseV2DetailDto> {
    const deposito = await this.warehouses.findOne(id, distributorId);
    const balances = await this.query.saldos(distributorId, {
      warehouseId: id,
    });
    return WarehouseMapper.toV2DetailDto(deposito, balances);
  }

  @Permiso('stock.gestionar')
  @Patch(':id')
  @Version('2')
  @ApiOperation({
    summary:
      'Editar un depósito (también su ubicación) o cambiar el predeterminado',
    description: `${UBICACION} Las dos en null borran la ubicación; si no vienen, no se toca.`,
  })
  @ApiParam({ name: 'id', description: 'Depósito UUID' })
  @ApiOkResponse({ type: WarehouseV2ResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({
    description:
      'Datos o identificador inválidos (latitud o longitud fuera de rango, una sola de las dos), o falta la distribuidora',
  })
  @ApiConflictResponse({
    description:
      'Código repetido, o se intenta sacar la marca / desactivar el predeterminado',
  })
  async updateV2(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<WarehouseV2ResponseDto> {
    return WarehouseMapper.toV2Dto(
      await this.warehouses.update(id, dto, distributorId),
    );
  }

  @Permiso('stock.gestionar')
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
