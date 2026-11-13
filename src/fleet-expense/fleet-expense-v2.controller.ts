import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { PayFromCashBoxDto } from '../cash/dto/pay-expense.dto';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import {
  FuelLoadQuoteResponseDto,
  FuelLoadV2PageDto,
  FuelLoadV2ResponseDto,
  PayAccidentDto,
  QuoteFuelLoadDto,
  ReceiveReimbursementDto,
  TireV2PageDto,
  TireV2ResponseDto,
  VehicleAccidentV2PageDto,
  VehicleAccidentV2ResponseDto,
} from './dto/fleet-expense-v2.dto';
import { QueryFuelLoadDto } from './dto/fuel-load.dto';
import { QueryTireDto } from './dto/tire.dto';
import { QueryVehicleAccidentDto } from './dto/vehicle-accident.dto';
import { importeEsperado } from './domain/fuel-consumption';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { FleetExpensePaymentService } from './fleet-expense-payment.service';
import { FuelLoadService } from './fuel-load.service';
import { TireService } from './tire.service';
import { VehicleAccidentService } from './vehicle-accident.service';
import { Permiso } from '../common/decorators/permiso.decorator';

const NO_EXISTE = 'No existe o es de otra distribuidora';
const CAJA_NO_ENCONTRADA = `${NO_EXISTE} (también la caja)`;
const CAJA_SIN_SESION =
  'La caja no tiene una sesión abierta o no alcanza el saldo';

/** Neumáticos con el estado de pago de su compra (API v2). */
@ApiTags('Fleet · Neumáticos (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'fleet/tires', version: '2' })
export class TireV2Controller {
  constructor(
    private readonly tires: TireService,
    private readonly pagos: FleetExpensePaymentService,
  ) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({ summary: 'Listar los neumáticos, con su estado de pago' })
  @ApiOkResponse({ type: TireV2PageDto })
  async findAll(
    @Query() query: QueryTireDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TireV2PageDto> {
    const { data, total } = await this.tires.findAll(distributorId, query);
    return { data: data.map((t) => FleetExpenseMapper.tireV2(t)), total };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver un neumático con su historial y su pago' })
  @ApiParam({ name: 'id', description: 'Neumático UUID' })
  @ApiOkResponse({ type: TireV2ResponseDto })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TireV2ResponseDto> {
    const neumatico = await this.tires.findOne(id, distributorId);
    const eventos = await this.tires.historial(id, distributorId);
    return FleetExpenseMapper.tireV2(neumatico, eventos);
  }

  @Permiso('flota.gestionar')
  @Post(':id/pay')
  @Idempotent()
  @ApiOperation({
    summary: 'Pagar la compra de un neumático desde una caja',
    description:
      'Egreso del costo del neumático de la caja elegida (efectivo, banco o billetera), categoría «Neumáticos». Una sola vez por neumático.',
  })
  @ApiParam({ name: 'id', description: 'Neumático UUID' })
  @ApiCreatedResponse({ type: TireV2ResponseDto })
  @ApiBadRequestResponse({
    description: '`paidAt` futuro o caja que no admite el pago',
  })
  @ApiNotFoundResponse({ description: CAJA_NO_ENCONTRADA })
  @ApiConflictResponse({
    description: `Ya está pago, no tiene costo, o ${CAJA_SIN_SESION.toLowerCase()}`,
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayFromCashBoxDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<TireV2ResponseDto> {
    await this.pagos.pagarNeumatico(id, dto, distributorId, userId);
    return FleetExpenseMapper.tireV2(
      await this.tires.findOne(id, distributorId),
    );
  }
}

/** Cargas de combustible con el estado de pago (API v2). */
@ApiTags('Fleet · Combustible (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'fleet/fuel-loads', version: '2' })
export class FuelLoadV2Controller {
  constructor(private readonly loads: FuelLoadService) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({
    summary: 'Consultar las cargas vigentes, con su estado de pago',
  })
  @ApiOkResponse({ type: FuelLoadV2PageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryFuelLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FuelLoadV2PageDto> {
    const pagina = await this.loads.findAll(distributorId, query);
    return {
      ...pagina,
      data: pagina.data.map((f) => FleetExpenseMapper.fuelLoadV2(f)),
    };
  }

  @Permiso('flota.ver')
  @Get('quote')
  @ApiOperation({
    summary: 'Calcular el importe de una carga',
    description:
      'Litros × precio por litro a 2 decimales: la misma cuenta con la que el alta valida el importe. El formulario lo muestra y lo ofrece como importe de la carga.',
  })
  @ApiOkResponse({ type: FuelLoadQuoteResponseDto })
  @ApiBadRequestResponse({ description: 'Litros o precio inválidos' })
  quote(@Query() query: QuoteFuelLoadDto): FuelLoadQuoteResponseDto {
    return {
      liters: query.liters,
      unitPrice: query.unitPrice,
      totalAmount: importeEsperado(query.liters, query.unitPrice),
    };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver una carga (también la anulada), con su pago' })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: FuelLoadV2ResponseDto })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FuelLoadV2ResponseDto> {
    return FleetExpenseMapper.fuelLoadV2(
      await this.loads.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/pay')
  @Idempotent()
  @ApiOperation({
    summary: 'Pagar una carga de combustible desde una caja',
    description:
      'Egreso del importe de la carga de la caja elegida (efectivo, banco o billetera), categoría «Combustible». Sirve para la carga de tarjeta o cuenta de combustible y para la de la caja que no se asentó. La que pagó el chofer con su efectivo (`driver_cash`) se salda en su rendición: responde 409.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiCreatedResponse({ type: FuelLoadV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      '`paidAt` futuro o anterior a la carga, o caja que no admite el pago',
  })
  @ApiNotFoundResponse({ description: CAJA_NO_ENCONTRADA })
  @ApiConflictResponse({
    description: `Ya salió de una caja, está anulada, la pagó el chofer con su efectivo, es anterior al asiento de caja, o ${CAJA_SIN_SESION.toLowerCase()}`,
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayFromCashBoxDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FuelLoadV2ResponseDto> {
    return FleetExpenseMapper.fuelLoadV2(
      await this.loads.pagar(id, dto, distributorId, userId),
    );
  }
}

/** Siniestros con lo que pagó la empresa y el reintegro del seguro (API v2). */
@ApiTags('Fleet · Siniestros (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'fleet/accidents', version: '2' })
export class VehicleAccidentV2Controller {
  constructor(
    private readonly accidents: VehicleAccidentService,
    private readonly pagos: FleetExpensePaymentService,
  ) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({
    summary: 'Consultar los siniestros, con su pago y reintegro',
  })
  @ApiOkResponse({ type: VehicleAccidentV2PageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryVehicleAccidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAccidentV2PageDto> {
    const { data, total } = await this.accidents.findAll(distributorId, query);
    return {
      data: data.map((s) => FleetExpenseMapper.vehicleAccidentV2(s)),
      total,
    };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver un siniestro, con su pago y reintegro' })
  @ApiParam({ name: 'id', description: 'Siniestro UUID' })
  @ApiOkResponse({ type: VehicleAccidentV2ResponseDto })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAccidentV2ResponseDto> {
    return FleetExpenseMapper.vehicleAccidentV2(
      await this.accidents.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/pay')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar lo que pagó la empresa por el siniestro',
    description:
      'Egreso de la caja elegida (efectivo, banco o billetera), categoría «Siniestros»: la reparación o la franquicia. Uno por siniestro, abierto o cerrado; con el siniestro cerrado, `amount` no puede superar el costo de la reparación (o la franquicia, si es mayor).',
  })
  @ApiParam({ name: 'id', description: 'Siniestro UUID' })
  @ApiCreatedResponse({ type: VehicleAccidentV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Importe mayor que lo cargado al cerrar, `paidAt` futuro o anterior al siniestro, o caja que no admite el pago',
  })
  @ApiNotFoundResponse({ description: CAJA_NO_ENCONTRADA })
  @ApiConflictResponse({
    description: `Ya tiene su pago registrado, o ${CAJA_SIN_SESION.toLowerCase()}`,
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayAccidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<VehicleAccidentV2ResponseDto> {
    await this.pagos.pagarSiniestro(id, dto, distributorId, userId);
    return FleetExpenseMapper.vehicleAccidentV2(
      await this.accidents.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/reimbursement')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar el reintegro que pagó el seguro',
    description:
      'Ingreso a la caja elegida (efectivo, banco o billetera), categoría «Reintegros de seguros». Uno por siniestro; con el siniestro cerrado, `amount` no puede superar el reintegro cargado al cerrar.',
  })
  @ApiParam({ name: 'id', description: 'Siniestro UUID' })
  @ApiCreatedResponse({ type: VehicleAccidentV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Importe mayor que el reintegro cargado al cerrar, `receivedAt` futuro o anterior al siniestro, o caja que no admite el cobro',
  })
  @ApiNotFoundResponse({ description: CAJA_NO_ENCONTRADA })
  @ApiConflictResponse({
    description:
      'Ya tiene su reintegro registrado, se cerró sin reintegro, o la caja exige una sesión abierta',
  })
  async reimbursement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveReimbursementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<VehicleAccidentV2ResponseDto> {
    await this.pagos.registrarReintegro(id, dto, distributorId, userId);
    return FleetExpenseMapper.vehicleAccidentV2(
      await this.accidents.findOne(id, distributorId),
    );
  }
}
