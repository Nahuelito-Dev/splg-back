import {
  Body,
  Controller,
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
import {
  ChargeTrafficFineDto,
  CreateTrafficFineDto,
  PayTrafficFineDto,
  QueryTrafficFineDto,
  TrafficFinePageDto,
  TrafficFineResponseDto,
  UpdateTrafficFineDto,
  VoidTrafficFineDto,
} from './dto/traffic-fine.dto';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { TrafficFineService } from './traffic-fine.service';

/** Multas de tránsito (CU-198 a CU-200, CU-323 a CU-325). */
@ApiTags('Fleet · Multas')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('fleet/fines')
export class TrafficFineController {
  constructor(private readonly fines: TrafficFineService) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar una multa de tránsito',
    description:
      'Nace pendiente. Si no se indica el responsable, se deduce del chofer que tenía el vehículo en uso en el instante de la infracción.',
  })
  @ApiCreatedResponse({ type: TrafficFineResponseDto })
  @ApiBadRequestResponse({
    description:
      'Dato obligatorio faltante, importe inválido, infracción futura, vencimiento anterior a la infracción o pago voluntario mayor al importe',
  })
  @ApiNotFoundResponse({ description: 'Vehículo o empleado no encontrado' })
  @ApiConflictResponse({
    description: 'La multa ya está registrada (misma jurisdicción y acta)',
  })
  async create(
    @Body() dto: CreateTrafficFineDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineResponseDto> {
    return FleetExpenseMapper.trafficFine(
      await this.fines.registrar(dto, distributorId),
    );
  }

  @Get()
  @ApiOperation({ summary: 'Consultar las multas de tránsito' })
  @ApiOkResponse({ type: TrafficFinePageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryTrafficFineDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFinePageDto> {
    const { data, total } = await this.fines.findAll(distributorId, query);
    return { data: data.map((m) => FleetExpenseMapper.trafficFine(m)), total };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver una multa' })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineResponseDto> {
    return FleetExpenseMapper.trafficFine(
      await this.fines.findOne(id, distributorId),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Modificar una multa o pasarla a apelada',
    description:
      'Con `appeal: true` pasa de pendiente a apelada. Una multa pagada o anulada no se modifica.',
  })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineResponseDto })
  @ApiBadRequestResponse({
    description:
      'Dato inválido, infracción futura o vencimiento anterior a la infracción',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Pagada, anulada, ya apelada, o el acta pertenece a otra multa',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTrafficFineDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineResponseDto> {
    return FleetExpenseMapper.trafficFine(
      await this.fines.modificar(id, dto, distributorId),
    );
  }

  @Patch(':id/pay')
  @ApiOperation({
    summary: 'Registrar el pago de una multa',
    description:
      'Con `paidInCash` el importe pagado sale de la caja de efectivo `cashBoxId` en la misma transacción (con cajas de efectivo activas es obligatoria). Una multa pagada no se anula ni se paga de nuevo: el asiento no se repite.',
  })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fecha de pago futura o anterior a la infracción, importe inválido, falta la caja de efectivo o la caja no es de efectivo',
  })
  @ApiNotFoundResponse({
    description: 'La multa o la caja no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'La multa no admite el pago (ya pagada o anulada), o la caja no tiene sesión abierta o saldo',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayTrafficFineDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<TrafficFineResponseDto> {
    return FleetExpenseMapper.trafficFine(
      await this.fines.pagar(id, dto, distributorId, userId),
    );
  }

  @Patch(':id/charge-to-employee')
  @ApiOperation({
    summary: 'Imputar una multa al chofer',
    description:
      'La asume el empleado y no cuenta como costo del vehículo. Una multa pagada también se imputa; una anulada no.',
  })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineResponseDto })
  @ApiBadRequestResponse({
    description: 'La multa no tiene responsable y no se indicó uno',
  })
  @ApiNotFoundResponse({
    description:
      'La multa o el empleado no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({ description: 'La multa anulada no se puede imputar' })
  async chargeToEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChargeTrafficFineDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineResponseDto> {
    return FleetExpenseMapper.trafficFine(
      await this.fines.imputar(id, dto, distributorId),
    );
  }

  @Patch(':id/void')
  @ApiOperation({
    summary: 'Anular una multa',
    description:
      'Baja lógica con motivo obligatorio. Una multa pagada no se anula.',
  })
  @ApiParam({ name: 'id', description: 'Multa UUID' })
  @ApiOkResponse({ type: TrafficFineResponseDto })
  @ApiBadRequestResponse({ description: 'Falta el motivo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La multa ya está pagada o anulada' })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidTrafficFineDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TrafficFineResponseDto> {
    return FleetExpenseMapper.trafficFine(
      await this.fines.anular(id, dto, distributorId),
    );
  }
}
