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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { DriverLiquidationService } from '../application/driver-liquidation.service';
import {
  CreateDriverLiquidationDto,
  DriverLiquidationDetailDto,
  DriverLiquidationPageDto,
  DriverLiquidationResponseDto,
  PayDriverLiquidationDto,
  QueryDriverLiquidationDto,
  UnpayDriverLiquidationDto,
} from '../dto/driver-liquidation.dto';
import { CommissionMapper } from './commission.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Liquidaciones de comisiones de los choferes (CU-242, 243, 334, 335). */
@ApiTags('Comisiones · Liquidaciones')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('driver-liquidations')
export class DriverLiquidationController {
  constructor(private readonly liquidaciones: DriverLiquidationService) {}

  @Permiso('finanzas.ver')
  @Get()
  @ApiOperation({ summary: 'Listar las liquidaciones' })
  @ApiOkResponse({ type: DriverLiquidationPageDto })
  async findAll(
    @Query() query: QueryDriverLiquidationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverLiquidationPageDto> {
    const { data, total } = await this.liquidaciones.findAll(
      distributorId,
      query,
    );
    return { data: data.map((l) => CommissionMapper.liquidacion(l)), total };
  }

  @Permiso('finanzas.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Liquidar las comisiones de un chofer',
    description:
      'Toma, bajo bloqueo, los asientos del chofer en el período que no pertenecen a otra liquidación y crea la liquidación en borrador. Bruto = lo que suma; deducciones = lo que resta; neto = bruto − deducciones.',
  })
  @ApiCreatedResponse({ type: DriverLiquidationResponseDto })
  @ApiBadRequestResponse({ description: 'Período inválido' })
  @ApiNotFoundResponse({
    description: 'El empleado no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'No hay asientos para liquidar en el período',
  })
  async create(
    @Body() dto: CreateDriverLiquidationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverLiquidationResponseDto> {
    return CommissionMapper.liquidacion(
      await this.liquidaciones.crear(dto, distributorId, userId),
    );
  }

  @Permiso('finanzas.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver una liquidación con sus asientos' })
  @ApiParam({ name: 'id', description: 'Liquidación UUID' })
  @ApiOkResponse({ type: DriverLiquidationDetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverLiquidationDetailDto> {
    const { item, asientos } = await this.liquidaciones.findOne(
      id,
      distributorId,
    );
    return CommissionMapper.liquidacionConAsientos(item, asientos);
  }

  @Permiso('finanzas.gestionar')
  @Patch(':id/approve')
  @Idempotent()
  @ApiOperation({ summary: 'Aprobar una liquidación en borrador' })
  @ApiParam({ name: 'id', description: 'Liquidación UUID' })
  @ApiOkResponse({ type: DriverLiquidationResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'No está en borrador' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverLiquidationResponseDto> {
    return CommissionMapper.liquidacion(
      await this.liquidaciones.aprobar(id, distributorId, userId),
    );
  }

  @Permiso('finanzas.gestionar')
  @Patch(':id/pay')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar el pago de una liquidación',
    description:
      'Asienta el egreso del neto en la caja con la categoría de sistema "pago de comisiones", en la misma transacción.',
  })
  @ApiParam({ name: 'id', description: 'Liquidación UUID' })
  @ApiOkResponse({ type: DriverLiquidationResponseDto })
  @ApiNotFoundResponse({
    description:
      'La liquidación o la caja no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'No está aprobada, la caja de efectivo no tiene saldo, o exige sesión y no la tiene abierta',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayDriverLiquidationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverLiquidationResponseDto> {
    return CommissionMapper.liquidacion(
      await this.liquidaciones.pagar(id, dto.cashBoxId, distributorId, userId),
    );
  }

  @Permiso('finanzas.gestionar')
  @Patch(':id/unpay')
  @Idempotent()
  @ApiOperation({
    summary: 'Anular el pago de una liquidación',
    description:
      'Asienta el contraasiento del pago en la misma caja (vuelve a entrar el neto) y deja la liquidación aprobada: se puede pagar de nuevo o anular. Es la única forma de corregir un pago; el movimiento de caja del pago no se anula desde `/cash-movements`.',
  })
  @ApiParam({ name: 'id', description: 'Liquidación UUID' })
  @ApiOkResponse({ type: DriverLiquidationResponseDto })
  @ApiBadRequestResponse({ description: 'Falta el motivo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'No está pagada' })
  async unpay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnpayDriverLiquidationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverLiquidationResponseDto> {
    return CommissionMapper.liquidacion(
      await this.liquidaciones.anularPago(
        id,
        dto.reason,
        distributorId,
        userId,
      ),
    );
  }

  @Permiso('finanzas.gestionar')
  @Patch(':id/void')
  @Idempotent()
  @ApiOperation({
    summary: 'Anular una liquidación',
    description:
      'Libera los asientos para que entren en otra. Una pagada no se anula directo: el pago ya sacó dinero de una caja; se anula antes el pago con `PATCH /driver-liquidations/:id/unpay`.',
  })
  @ApiParam({ name: 'id', description: 'Liquidación UUID' })
  @ApiOkResponse({ type: DriverLiquidationResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'Está pagada (anulá antes el pago) o ya anulada',
  })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverLiquidationResponseDto> {
    return CommissionMapper.liquidacion(
      await this.liquidaciones.anular(id, distributorId),
    );
  }
}
