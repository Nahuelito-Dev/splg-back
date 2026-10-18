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
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CustomerAccountQueryService } from '../application/customer-account-query.service';
import { CustomerAccountService } from '../application/customer-account.service';
import { CustomerLedgerService } from '../application/customer-ledger.service';
import {
  AgingReportDto,
  CreateCustomerAccountDto,
  CustomerAccountDetailDto,
  CustomerAccountPageDto,
  CustomerEntryResponseDto,
  CustomerStatementDto,
  QueryCustomerAccountDto,
  QueryCustomerEntryDto,
  RegisterAdjustmentDto,
  RegisterPaymentDto,
  UpdateCustomerAccountDto,
} from '../dto/customer-account.dto';
import { CustomerAccountMapper } from './customer-account.mapper';

/** Cuentas corrientes de clientes (CU-235, 237, 238, 239, 329, 331). */
@ApiTags('Cuentas corrientes')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('customer-accounts')
export class CustomerAccountController {
  constructor(
    private readonly cuentas: CustomerAccountService,
    private readonly consultas: CustomerAccountQueryService,
    private readonly ledger: CustomerLedgerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar las cuentas corrientes',
    description:
      'Con saldo, crédito disponible y deuda vencida de cada cuenta. Filtra por estado, deuda vencida y texto (razón social, CUIT, nombre o correo).',
  })
  @ApiOkResponse({ type: CustomerAccountPageDto })
  findAll(
    @Query() query: QueryCustomerAccountDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CustomerAccountPageDto> {
    return this.consultas.findAll(distributorId, query);
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Habilitar la cuenta corriente de un cliente',
    description:
      'La cuenta es de la distribuidora y no del cliente: el cliente es una persona compartida entre distribuidoras y la deuda, el límite y el plazo son de cada relación comercial.',
  })
  @ApiCreatedResponse({ type: CustomerAccountDetailDto })
  @ApiBadRequestResponse({
    description: 'CUIT inválido, límite negativo o plazo no positivo',
  })
  @ApiNotFoundResponse({ description: 'El cliente no existe' })
  @ApiConflictResponse({
    description: 'El cliente ya tiene una cuenta vigente en la distribuidora',
  })
  async create(
    @Body() dto: CreateCustomerAccountDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CustomerAccountDetailDto> {
    const cuenta = await this.cuentas.habilitar(dto, distributorId);
    return this.consultas.findOne(cuenta.accountId, distributorId);
  }

  @Get('aging')
  @ApiOperation({
    summary: 'Antigüedad de la deuda',
    description:
      'Lo que se debe repartido en 0-30, 31-60, 61-90 y más de 90 días desde la fecha del comprobante, por cuenta y en total.',
  })
  @ApiOkResponse({ type: AgingReportDto })
  aging(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<AgingReportDto> {
    return this.consultas.aging(distributorId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Ver una cuenta con su crédito disponible y su antigüedad',
  })
  @ApiParam({ name: 'id', description: 'Cuenta UUID' })
  @ApiOkResponse({ type: CustomerAccountDetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CustomerAccountDetailDto> {
    return this.consultas.findOne(id, distributorId);
  }

  @Patch(':id')
  @Idempotent()
  @ApiOperation({
    summary: 'Modificar una cuenta corriente',
    description:
      'Límite, plazo, datos fiscales y estado (bloquear o cerrar). La cuenta conserva su saldo y sus asientos.',
  })
  @ApiParam({ name: 'id', description: 'Cuenta UUID' })
  @ApiOkResponse({ type: CustomerAccountDetailDto })
  @ApiBadRequestResponse({ description: 'Límite negativo o plazo no positivo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Se cierra con saldo distinto de cero o con pedidos a cuenta sin entregar',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerAccountDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CustomerAccountDetailDto> {
    await this.cuentas.modificar(id, dto, distributorId);
    return this.consultas.findOne(id, distributorId);
  }

  @Get(':id/entries')
  @ApiOperation({
    summary: 'Estado de cuenta',
    description:
      'Los asientos del período con el saldo corrido después de cada uno, el saldo de apertura y el de cierre.',
  })
  @ApiParam({ name: 'id', description: 'Cuenta UUID' })
  @ApiOkResponse({ type: CustomerStatementDto })
  @ApiBadRequestResponse({ description: 'Período inválido' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  entries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryCustomerEntryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CustomerStatementDto> {
    return this.consultas.entries(id, distributorId, query);
  }

  @Post(':id/payments')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar un pago de cuenta corriente',
    description:
      'El administrador indica la caja y el sistema asienta la entrada. El chofer cobra en la calle: no manda caja, el pago queda atado a su rendición abierta (suma al efectivo esperado) y entra a la caja cuando se aprueba la rendición. La imputación a los cargos es automática, del más viejo al más nuevo.',
  })
  @ApiParam({ name: 'id', description: 'Cuenta UUID' })
  @ApiCreatedResponse({ type: CustomerEntryResponseDto })
  @ApiBadRequestResponse({
    description:
      'Importe no positivo; el chofer manda caja o un medio que no es efectivo',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description:
      'Falta la caja (administrador), la caja exige sesión y no la tiene abierta, el chofer no tiene rendición abierta, o la cuenta está cerrada',
  })
  async registerPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CustomerEntryResponseDto> {
    const asiento = await this.ledger.registrarPago(id, dto, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
    return CustomerAccountMapper.asiento(
      asiento,
      user.role === RoleType.DELIVERY,
    );
  }

  @Post(':id/adjustments')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar un ajuste de cuenta corriente',
    description:
      'Nota de crédito (baja la deuda) o de débito (la sube), con su motivo. El libro no se edita: un asiento equivocado se corrige con un ajuste.',
  })
  @ApiParam({ name: 'id', description: 'Cuenta UUID' })
  @ApiCreatedResponse({ type: CustomerEntryResponseDto })
  @ApiBadRequestResponse({
    description: 'Tipo inválido, falta el motivo o el importe no es positivo',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La cuenta está cerrada' })
  async registerAdjustment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterAdjustmentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CustomerEntryResponseDto> {
    return CustomerAccountMapper.asiento(
      await this.ledger.registrarAjuste(id, dto, distributorId, userId),
    );
  }
}
