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
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import {
  CreateFuelLoadDto,
  CreateMyFuelLoadDto,
  FuelLoadPageDto,
  FuelLoadResponseDto,
  PayFuelLoadFromCashBoxDto,
  QueryFuelLoadDto,
  UpdateFuelLoadDto,
} from './dto/fuel-load.dto';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { FuelLoadService } from './fuel-load.service';

/** Cargas de combustible de la flota (CU-195, CU-320 a CU-322). */
@ApiTags('Fleet · Combustible')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('fleet/fuel-loads')
export class FuelLoadController {
  constructor(private readonly loads: FuelLoadService) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar una carga de combustible (administrador)',
    description:
      'Valida el importe contra litros × precio (±1 %), los litros contra el tanque (+5 %) y el kilometraje contra la última carga. Sube el kilometraje del vehículo y marca la carga como anómala si el consumo del tramo se aparta más de un 25 % del habitual (avisa a los administradores).',
  })
  @ApiCreatedResponse({ type: FuelLoadResponseDto })
  @ApiBadRequestResponse({
    description:
      'Importe, litros o kilometraje inválidos; falta el combustible del vehículo',
  })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  async create(
    @Body() dto: CreateFuelLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FuelLoadResponseDto> {
    return FleetExpenseMapper.fuelLoad(
      await this.loads.registrar(dto, distributorId, userId),
    );
  }

  @Post('mine')
  @Idempotent()
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Registrar una carga de combustible (chofer)',
    description:
      'Siempre del vehículo que el chofer tiene en uso; no admite corrección de kilometraje.',
  })
  @ApiCreatedResponse({ type: FuelLoadResponseDto })
  @ApiBadRequestResponse({
    description: 'Importe, litros o kilometraje inválidos',
  })
  @ApiNotFoundResponse({ description: 'No tenés un vehículo en uso' })
  async createMine(
    @Body() dto: CreateMyFuelLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FuelLoadResponseDto> {
    return FleetExpenseMapper.fuelLoad(
      await this.loads.registrarPropia(dto, distributorId, userId),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Consultar las cargas de combustible vigentes',
    description:
      'Filtra por vehículo, chofer, rango de fechas y anomalía. Devuelve la página y el total de litros e importe de lo filtrado.',
  })
  @ApiOkResponse({ type: FuelLoadPageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryFuelLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FuelLoadPageDto> {
    const pagina = await this.loads.findAll(distributorId, query);
    return {
      ...pagina,
      data: pagina.data.map((f) => FleetExpenseMapper.fuelLoad(f)),
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Ver una carga de combustible (también la anulada)',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: FuelLoadResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FuelLoadResponseDto> {
    return FleetExpenseMapper.fuelLoad(
      await this.loads.findOne(id, distributorId),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Modificar una carga de combustible',
    description:
      'Revalida las mismas reglas que el alta y recalcula el kilometraje del vehículo y la anomalía de la carga.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: FuelLoadResponseDto })
  @ApiBadRequestResponse({
    description: 'Importe, litros o kilometraje inválidos',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La carga está anulada' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFuelLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FuelLoadResponseDto> {
    return FleetExpenseMapper.fuelLoad(
      await this.loads.modificar(id, dto, distributorId),
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Anular una carga de combustible',
    description:
      'Baja lógica: la carga se conserva, deja de contar en el consumo y el costo, y si era la última el kilometraje del vehículo vuelve al de la anterior.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La carga ya estaba anulada' })
  anular(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<MessageResponseDto> {
    return this.loads.anular(id, distributorId, userId);
  }

  @Patch(':id/cash-payment')
  @Idempotent()
  @ApiOperation({
    summary: 'Asentar en una caja una carga pagada de la caja',
    description:
      'Para la carga que registró el chofer con `paymentMethod: cash_box` (él no elige la caja): el importe sale de la caja de efectivo indicada en la misma transacción. Una carga ya asentada responde 409 y no se asienta dos veces.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: FuelLoadResponseDto })
  @ApiBadRequestResponse({
    description: 'La carga no es de la caja, o la caja no es de efectivo',
  })
  @ApiNotFoundResponse({
    description: 'La carga o la caja no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'La carga está anulada o ya salió de una caja; la caja no tiene sesión abierta o saldo',
  })
  async payFromCashBox(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayFuelLoadFromCashBoxDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FuelLoadResponseDto> {
    return FleetExpenseMapper.fuelLoad(
      await this.loads.pagarDesdeCaja(id, dto.cashBoxId, distributorId, userId),
    );
  }
}
