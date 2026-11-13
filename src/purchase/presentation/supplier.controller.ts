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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { MessageResponseDto } from '../../common/dtos/message-response.dto';
import { PurchaseQueryService } from '../application/purchase-query.service';
import { SupplierService } from '../application/supplier.service';
import {
  QuerySupplierHistoryDto,
  SupplierHistoryDto,
} from '../dto/purchase-receipt.dto';
import {
  CreateSupplierDto,
  QuerySupplierDto,
  SupplierPageDto,
  SupplierResponseDto,
  UpdateSupplierDto,
} from '../dto/supplier.dto';
import { SupplierMapper } from './supplier.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Proveedores de la distribuidora (CU-214). Baja lógica. */
@ApiTags('Compras · Proveedores')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('suppliers')
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly queries: PurchaseQueryService,
  ) {}

  @Permiso('stock.ver')
  @Get()
  @ApiOperation({ summary: 'Listar los proveedores, paginado y filtrable' })
  @ApiOkResponse({ type: SupplierPageDto })
  async findAll(
    @Query() query: QuerySupplierDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<SupplierPageDto> {
    const { data, total } = await this.suppliers.findAll(distributorId, query);
    return { data: data.map((s) => SupplierMapper.toDto(s)), total };
  }

  @Permiso('compras.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Crear un proveedor',
    description:
      'El CUIT se valida (prefijo y dígito verificador) y es único entre los proveedores vigentes de la distribuidora.',
  })
  @ApiCreatedResponse({ type: SupplierResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o CUIT mal formado' })
  @ApiConflictResponse({
    description: 'Ya hay un proveedor vigente con ese CUIT',
  })
  async create(
    @Body() dto: CreateSupplierDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<SupplierResponseDto> {
    return SupplierMapper.toDto(
      await this.suppliers.create(dto, distributorId),
    );
  }

  @Permiso('stock.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver un proveedor' })
  @ApiParam({ name: 'id', description: 'Proveedor UUID' })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<SupplierResponseDto> {
    return SupplierMapper.toDto(
      await this.suppliers.findOne(id, distributorId),
    );
  }

  @Permiso('stock.ver')
  @Get(':id/purchase-history')
  @ApiOperation({
    summary: 'Historial de compras de un proveedor',
    description:
      'Recepciones del proveedor (las anuladas incluidas en la lista), con el total y las llenas de las confirmadas del período. También para un proveedor dado de baja.',
  })
  @ApiParam({ name: 'id', description: 'Proveedor UUID' })
  @ApiOkResponse({ type: SupplierHistoryDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  historial(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QuerySupplierHistoryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<SupplierHistoryDto> {
    return this.queries.historialDeProveedor(id, distributorId, query);
  }

  @Permiso('compras.gestionar')
  @Patch(':id')
  @ApiOperation({ summary: 'Editar un proveedor' })
  @ApiParam({ name: 'id', description: 'Proveedor UUID' })
  @ApiOkResponse({ type: SupplierResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'El CUIT ya lo tiene otro proveedor vigente',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<SupplierResponseDto> {
    return SupplierMapper.toDto(
      await this.suppliers.update(id, dto, distributorId),
    );
  }

  @Permiso('compras.gestionar')
  @Delete(':id')
  @ApiOperation({ summary: 'Dar de baja un proveedor (baja lógica)' })
  @ApiParam({ name: 'id', description: 'Proveedor UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'Tiene órdenes de compra abiertas' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MessageResponseDto> {
    await this.suppliers.remove(id, distributorId);
    return MessageResponseDto.of('Proveedor dado de baja');
  }
}
