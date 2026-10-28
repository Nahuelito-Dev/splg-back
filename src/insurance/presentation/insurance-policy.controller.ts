import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { InsurancePolicyService } from '../application/insurance-policy.service';
import { InsuranceQueryService } from '../application/insurance-query.service';
import {
  CancelInsurancePolicyDto,
  CancelledInsurancePolicyDto,
  CarInsuranceResponseDto,
  CreatedInsurancePolicyDto,
  CreateInsurancePolicyDto,
  InsurancePolicyResponseDto,
  UpdateInsurancePolicyDto,
} from '../dto/insurance-policy.dto';
import { InsuranceMapper } from './insurance.mapper';

/** Pólizas de seguro de los vehículos y su plan de cuotas (API v2). */
@ApiTags('Seguros · Pólizas')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ version: '2' })
export class InsurancePolicyController {
  constructor(
    private readonly policies: InsurancePolicyService,
    private readonly consultas: InsuranceQueryService,
  ) {}

  @Get('cars/:carId/insurance')
  @ApiOperation({
    summary: 'El seguro de un vehículo',
    description:
      'La póliza que cubre hoy (o, si no hay, la próxima) con su aseguradora, el enlace de pago, el código de pago y sus cuotas (estado, vencimiento, gracia, comprobante y movimiento de caja), más el historial de las demás pólizas.',
  })
  @ApiParam({ name: 'carId', description: 'Vehículo UUID' })
  @ApiOkResponse({ type: CarInsuranceResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async ofCar(
    @Param('carId', ParseUUIDPipe) carId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarInsuranceResponseDto> {
    const { current, history } = await this.consultas.ofCar(
      carId,
      distributorId,
    );
    return InsuranceMapper.carInsurance(carId, current, history);
  }

  @Post('insurance-policies')
  @Idempotent()
  @ApiOperation({
    summary: 'Dar de alta una póliza con su plan de cuotas',
    description:
      'Genera `installments.count` cuotas mensuales el mismo día de cada mes (si el mes no lo tiene, el último), cada una con su gracia. Deja la tarea de seguro del vehículo en la flota con el vencimiento de la póliza y cierra la anterior; `fleet` dice si se sincronizó o por qué no (por ejemplo, si la distribuidora no tiene plan de seguro). Renovar es dar de alta la póliza nueva: un vehículo no tiene dos pólizas no canceladas con vigencias solapadas.',
  })
  @ApiCreatedResponse({ type: CreatedInsurancePolicyDto })
  @ApiBadRequestResponse({
    description:
      'Fechas incoherentes, cuotas fuera de la vigencia o dato inválido',
  })
  @ApiNotFoundResponse({
    description:
      'El vehículo o la aseguradora no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'El vehículo ya tiene una póliza en esas fechas, o el número de póliza ya está cargado para la aseguradora',
  })
  async create(
    @Body() dto: CreateInsurancePolicyDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CreatedInsurancePolicyDto> {
    const { policyId, fleet } = await this.policies.crear(dto, distributorId);
    const poliza = await this.consultas.findPolicy(policyId, distributorId);
    return Object.assign(InsuranceMapper.policy(poliza), { fleet });
  }

  @Get('insurance-policies/:id')
  @ApiOperation({ summary: 'Ver una póliza con sus cuotas' })
  @ApiParam({ name: 'id', description: 'Póliza UUID' })
  @ApiOkResponse({ type: InsurancePolicyResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsurancePolicyResponseDto> {
    return InsuranceMapper.policy(
      await this.consultas.findPolicy(id, distributorId),
    );
  }

  @Patch('insurance-policies/:id')
  @ApiOperation({
    summary: 'Modificar una póliza',
    description:
      'Aseguradora, número, cobertura y código de pago. La vigencia y las cuotas no se editan: se cancela la póliza y se da de alta otra.',
  })
  @ApiParam({ name: 'id', description: 'Póliza UUID' })
  @ApiOkResponse({ type: InsurancePolicyResponseDto })
  @ApiBadRequestResponse({ description: 'Dato inválido' })
  @ApiNotFoundResponse({
    description:
      'La póliza o la aseguradora no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'La póliza está cancelada o el número ya está cargado',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInsurancePolicyDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InsurancePolicyResponseDto> {
    await this.policies.modificar(id, dto, distributorId);
    return InsuranceMapper.policy(
      await this.consultas.findPolicy(id, distributorId),
    );
  }

  @Post('insurance-policies/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Cancelar una póliza',
    description:
      'Baja lógica con motivo. Las cuotas pendientes pasan a canceladas; las pagas se conservan con su comprobante y su egreso de caja. En la flota cancela la tarea de seguro que creó la póliza y reabre las que dio por hechas; una tarea que alguien cambió mientras tanto no se toca y `fleetRevert.notes` lo informa.',
  })
  @ApiParam({ name: 'id', description: 'Póliza UUID' })
  @ApiOkResponse({ type: CancelledInsurancePolicyDto })
  @ApiBadRequestResponse({ description: 'Falta el motivo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La póliza ya está cancelada' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelInsurancePolicyDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CancelledInsurancePolicyDto> {
    const fleetRevert = await this.policies.cancelar(id, dto, distributorId);
    return Object.assign(
      InsuranceMapper.policy(
        await this.consultas.findPolicy(id, distributorId),
      ),
      { fleetRevert },
    );
  }
}
