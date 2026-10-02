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
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { GasCylinderService } from './gascylinder.service';
import { PublicIdentificable } from '../common/decorators/isPublic.decorator';
import { UpdateStockDto } from './dto/update-stock.dto';
import { CreateGasCylinderDto } from './dto/create-gascylinder.dto';
import { UpdateGasCylinderDto } from './dto/update-gascylinder.dto';
import {
  CatalogQueryDto,
  DistribuidoraQueryDto,
  TipoParamDto,
} from './dto/catalog-query.dto';
import {
  BajaDeProductoDto,
  CatalogoDto,
  DisponiblesDto,
  GasCylinderResponseDto,
} from './dto/gascylinder-response.dto';
import { GasCylinderMapper } from './gascylinder.mapper';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Gas Cylinders')
@ApiBearerAuth()
@Controller('gascylinder')
export class GasCylinderController {
  constructor(private readonly gasCylinderService: GasCylinderService) {}

  @Post()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new gas cylinder type' })
  @ApiCreatedResponse({ type: GasCylinderResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o tipo repetido' })
  async create(
    @Body() createGasCylinderDto: CreateGasCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<GasCylinderResponseDto> {
    return GasCylinderMapper.toDto(
      await this.gasCylinderService.create(createGasCylinderDto, distributorId),
    );
  }

  @Get()
  @PublicIdentificable()
  @ApiOperation({
    summary: 'Get all gas cylinders with pagination',
    description:
      'Público. Con sesión iniciada se acota a la distribuidora del usuario ' +
      '(la del admin, o el header `X-Distributor` del super admin y del ' +
      'cliente); sin sesión, a `?distributor=` o a la distribuidora por defecto.',
  })
  @ApiOkResponse({ type: CatalogoDto })
  async findAll(
    @Query() query: CatalogQueryDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CatalogoDto> {
    const pagina = await this.gasCylinderService.findAll(
      query,
      distributorId ?? query.distributor,
    );
    return {
      ...pagina,
      gasCylinders: pagina.gasCylinders.map((g) => GasCylinderMapper.toDto(g)),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get gas cylinder by ID' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiOkResponse({ type: GasCylinderResponseDto })
  @ApiNotFoundResponse({ description: 'Gas cylinder not found' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GasCylinderResponseDto> {
    // El catálogo es público: no se acota por distribuidora.
    return GasCylinderMapper.toDto(await this.gasCylinderService.findOne(id));
  }

  @Get('type/:type')
  @ApiOperation({ summary: 'Get gas cylinder by type' })
  @ApiParam({
    name: 'type',
    description: 'Gas cylinder type (10kg, 15kg, etc)',
  })
  @ApiOkResponse({ type: GasCylinderResponseDto })
  @ApiNotFoundResponse({ description: 'No hay un producto activo de ese tipo' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findByType(
    @Param() { type }: TipoParamDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<GasCylinderResponseDto> {
    return GasCylinderMapper.toDto(
      await this.gasCylinderService.findByType(
        type,
        distributorId ?? undefined,
      ),
    );
  }

  @Get('available/list')
  @PublicIdentificable()
  @ApiOperation({
    summary: 'Get all available gas cylinders',
    description:
      'Público. Con sesión iniciada se acota a la distribuidora del usuario; ' +
      'sin sesión, a `?distributor=` o a la distribuidora por defecto.',
  })
  @ApiOkResponse({ type: DisponiblesDto })
  async getAvailableCylinders(
    @Query() { distributor }: DistribuidoraQueryDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DisponiblesDto> {
    const { products, paymentMethods } =
      await this.gasCylinderService.getAvailableCylinders(
        distributorId ?? distributor,
      );
    return {
      products: products.map((g) => GasCylinderMapper.toDto(g)),
      paymentMethods,
    };
  }

  @Patch(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update gas cylinder by ID' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiOkResponse({ type: GasCylinderResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: weight debe ser mayor que 0; price debe ser mayor que 0)',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateGasCylinderDto: UpdateGasCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<GasCylinderResponseDto> {
    return GasCylinderMapper.toDto(
      await this.gasCylinderService.update(
        id,
        updateGasCylinderDto,
        distributorId,
      ),
    );
  }

  @Patch(':id/stock')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update gas cylinder stock' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiOkResponse({ type: GasCylinderResponseDto })
  @ApiBadRequestResponse({ description: 'El stock quedaría negativo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async updateStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStockDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<GasCylinderResponseDto> {
    return GasCylinderMapper.toDto(
      await this.gasCylinderService.updateStock(
        id,
        dto.quantity,
        distributorId,
      ),
    );
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete (deactivate) gas cylinder by ID' })
  @ApiParam({ name: 'id', description: 'Gas cylinder UUID' })
  @ApiOkResponse({ type: BajaDeProductoDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<BajaDeProductoDto> {
    return this.gasCylinderService.remove(id, distributorId);
  }
}
