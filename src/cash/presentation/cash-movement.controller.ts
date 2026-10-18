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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import {
  CashMovementService,
  MovimientoConNombres,
} from '../application/cash-movement.service';
import { CashMapper } from '../cash.mapper';
import {
  CashMovementPageDto,
  CashMovementResponseDto,
  CashTransferResponseDto,
  CreateCashMovementDto,
  QueryCashMovementDto,
  ReverseCashMovementDto,
  TransferCashDto,
} from '../dto/cash-movement.dto';

const aDto = (m: MovimientoConNombres): CashMovementResponseDto =>
  CashMapper.movimiento(m.movimiento, m);

/** Libro de movimientos de caja (CU-228, 229, 309, 310, 340). */
@ApiTags('Finanzas · Movimientos de caja')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('cash-movements')
export class CashMovementController {
  constructor(private readonly movimientos: CashMovementService) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar los movimientos de caja',
    description:
      'Del más nuevo al más viejo. Filtra por caja, categoría, sentido, origen y período (días en hora argentina, ambos inclusive).',
  })
  @ApiOkResponse({ type: CashMovementPageDto })
  @ApiBadRequestResponse({ description: 'Período o filtro inválido' })
  @ApiNotFoundResponse({
    description: 'La caja no existe o es de otra distribuidora',
  })
  async findAll(
    @Query() query: QueryCashMovementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashMovementPageDto> {
    const { data, total } = await this.movimientos.consultar(
      distributorId,
      query,
    );
    return { data: data.map(aDto), total };
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar una entrada o una salida de dinero',
    description:
      'Entrada (`direction: in`) o salida (`out`) manual, con una categoría del mismo sentido. Baja o sube el saldo de la caja en la misma transacción. Una caja de efectivo no puede quedar en negativo y una que exige sesión necesita tenerla abierta.',
  })
  @ApiCreatedResponse({ type: CashMovementResponseDto })
  @ApiBadRequestResponse({
    description: 'Importe no positivo o categoría de otro sentido',
  })
  @ApiNotFoundResponse({
    description: 'Caja o categoría inexistente o de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'Sin sesión abierta, caja desactivada o saldo insuficiente',
  })
  async create(
    @Body() dto: CreateCashMovementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CashMovementResponseDto> {
    return aDto(await this.movimientos.registrar(dto, distributorId, userId));
  }

  @Post('transfer')
  @Idempotent()
  @ApiOperation({
    summary: 'Transferir fondos entre cajas',
    description:
      'Salida en el origen y entrada en el destino por el mismo monto, en una sola transacción: o se registran los dos movimientos o ninguno.',
  })
  @ApiCreatedResponse({ type: CashTransferResponseDto })
  @ApiBadRequestResponse({
    description: 'Mismo origen y destino, o monto no positivo',
  })
  @ApiNotFoundResponse({
    description: 'Alguna caja no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'Sin sesión abierta o saldo insuficiente en el origen',
  })
  async transfer(
    @Body() dto: TransferCashDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CashTransferResponseDto> {
    const r = await this.movimientos.transferir(dto, distributorId, userId);
    return { out: aDto(r.out), in: aDto(r.in) };
  }

  @Post(':id/reverse')
  @Idempotent()
  @ApiOperation({
    summary: 'Anular un movimiento manual de caja',
    description:
      'Asienta el contraasiento (mismo importe, sentido opuesto) con el motivo. El libro no se edita ni se borra. Sólo se anulan los movimientos manuales: las patas de una transferencia se anulan con `reverse-transfer`; el pago de una liquidación, con `PATCH /driver-liquidations/:id/unpay`; los cobros de cuenta corriente, con un ajuste de la cuenta; la rendición aprobada y los ajustes de arqueo se corrigen con un movimiento manual.',
  })
  @ApiParam({ name: 'id', description: 'Movimiento UUID' })
  @ApiCreatedResponse({ type: CashMovementResponseDto })
  @ApiBadRequestResponse({
    description:
      'Falta el motivo, o el movimiento no es manual (el mensaje dice por qué caso de uso se corrige)',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Ya fue anulado, es una anulación, o el contraasiento dejaría la caja de efectivo en negativo',
  })
  async reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseCashMovementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CashMovementResponseDto> {
    return aDto(
      await this.movimientos.anular(id, dto.reason, distributorId, userId),
    );
  }

  @Post(':id/reverse-transfer')
  @Idempotent()
  @ApiOperation({
    summary: 'Anular una transferencia entre cajas',
    description:
      'Revierte las dos patas juntas (devuelve el dinero al origen y lo saca del destino) en una sola transacción. Se puede pedir por cualquiera de las dos patas. Si el destino es una caja de efectivo y ya no tiene el saldo, no se anula nada.',
  })
  @ApiParam({
    name: 'id',
    description: 'Movimiento UUID (cualquiera de las patas)',
  })
  @ApiCreatedResponse({ type: CashTransferResponseDto })
  @ApiBadRequestResponse({
    description: 'Falta el motivo o el movimiento no es una transferencia',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'La transferencia ya fue anulada o el destino no tiene el saldo para devolverla',
  })
  async reverseTransfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseCashMovementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CashTransferResponseDto> {
    const r = await this.movimientos.anularTransferencia(
      id,
      dto.reason,
      distributorId,
      userId,
    );
    return { out: aDto(r.out), in: aDto(r.in) };
  }
}
