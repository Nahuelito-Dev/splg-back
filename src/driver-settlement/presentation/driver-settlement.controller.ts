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
import { DriverSettlementQueryService } from '../application/driver-settlement-query.service';
import { DriverSettlementService } from '../application/driver-settlement.service';
import {
  ApproveDriverSettlementDto,
  DriverSettlementDetailDto,
  DriverSettlementPageDto,
  OpenDriverSettlementDto,
  QueryDriverSettlementDto,
  QueryMySettlementDto,
  SubmitDriverSettlementDto,
} from '../dto/driver-settlement.dto';

/** Rendición diaria del chofer (CU-231, 232, 233, 330). */
@ApiTags('Rendiciones del chofer')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('driver-settlements')
export class DriverSettlementController {
  constructor(
    private readonly rendiciones: DriverSettlementService,
    private readonly consultas: DriverSettlementQueryService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar las rendiciones (tablero del día por chofer)',
    description:
      'Esperado, declarado, diferencia y estado de cada rendición. En las abiertas, lo esperado se calcula en vivo.',
  })
  @ApiOkResponse({ type: DriverSettlementPageDto })
  findAll(
    @Query() query: QueryDriverSettlementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverSettlementPageDto> {
    return this.consultas.findAll(distributorId, query);
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Abrir la rendición de un chofer para un día',
    description:
      'Además la abre sola, cada noche, para los choferes con pedidos en efectivo sin rendir. Si el chofer tuvo una carga de camión ese día, la rendición queda atada a ella.',
  })
  @ApiCreatedResponse({ type: DriverSettlementDetailDto })
  @ApiNotFoundResponse({
    description: 'El chofer no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'El chofer ya tiene la rendición de ese día',
  })
  async open(
    @Body() dto: OpenDriverSettlementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverSettlementDetailDto> {
    const s = await this.rendiciones.abrir(
      distributorId,
      dto.deliveryId,
      dto.businessDate,
      true,
    );
    return this.consultas.detalle(s.settlementId, distributorId);
  }

  @Get('mine')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Mi rendición del día (chofer)',
    description:
      'Los pedidos en efectivo del día, los cobros de cuenta corriente y el efectivo esperado. Si todavía no existe, la abre (idempotente): el chofer necesita tenerla abierta para registrar cobros en la calle.',
  })
  @ApiOkResponse({ type: DriverSettlementDetailDto })
  @ApiNotFoundResponse({ description: 'El usuario no tiene perfil de chofer' })
  async mine(
    @Query() query: QueryMySettlementDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverSettlementDetailDto> {
    const { deliveryId, businessDate } = await this.consultas.miRendicionId(
      userId,
      distributorId,
      query.date,
    );
    const s = await this.rendiciones.abrir(
      distributorId,
      deliveryId,
      businessDate,
      false,
    );
    return this.consultas.detalle(s.settlementId, distributorId, userId);
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Ver una rendición con sus pedidos, cobros y gastos',
    description: 'El chofer sólo ve las suyas.',
  })
  @ApiParam({ name: 'id', description: 'Rendición UUID' })
  @ApiOkResponse({ type: DriverSettlementDetailDto })
  @ApiNotFoundResponse({
    description:
      'No existe, es de otra distribuidora o (chofer) de otro chofer',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverSettlementDetailDto> {
    return this.consultas.detalle(
      id,
      distributorId,
      user.role === RoleType.DELIVERY ? user.user_id : undefined,
    );
  }

  @Post(':id/submit')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @Idempotent()
  @ApiOperation({
    summary: 'Declarar el efectivo rendido',
    description:
      'El chofer (o el administrador por él) declara el efectivo y los gastos pagados con la cobranza. Recalcula lo esperado y toma los pedidos en efectivo sin rendir. Diferencia = declarado + gastos − esperado (negativa: faltante).',
  })
  @ApiParam({ name: 'id', description: 'Rendición UUID' })
  @ApiOkResponse({ type: DriverSettlementDetailDto })
  @ApiBadRequestResponse({
    description:
      'Efectivo o gasto negativo, o un gasto sin categoría de egreso',
  })
  @ApiNotFoundResponse({
    description:
      'No existe, es de otra distribuidora o (chofer) de otro chofer',
  })
  @ApiConflictResponse({ description: 'La rendición no está abierta' })
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitDriverSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverSettlementDetailDto> {
    const soloDelUsuario =
      user.role === RoleType.DELIVERY ? user.user_id : undefined;
    await this.rendiciones.presentar(
      id,
      dto,
      distributorId,
      user.user_id,
      soloDelUsuario,
    );
    return this.consultas.detalle(id, distributorId, soloDelUsuario);
  }

  @Patch(':id/approve')
  @Idempotent()
  @ApiOperation({
    summary: 'Aprobar la rendición del chofer',
    description:
      'Asienta la entrada del efectivo declarado en la caja destino (categoría de sistema "rendición de chofer"). Con diferencia, hay que decir cómo se resuelve: `absorbed` o `charged_to_driver` (sólo faltantes; se descuenta en la próxima liquidación).',
  })
  @ApiParam({ name: 'id', description: 'Rendición UUID' })
  @ApiOkResponse({ type: DriverSettlementDetailDto })
  @ApiBadRequestResponse({
    description:
      'Hay diferencia y no se indica cómo se resuelve, o un sobrante a cargo del chofer',
  })
  @ApiNotFoundResponse({
    description:
      'La rendición o la caja no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'No está presentada, la caja exige sesión y no la tiene abierta, o la carga del camión no está cerrada',
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveDriverSettlementDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverSettlementDetailDto> {
    await this.rendiciones.aprobar(id, dto, distributorId, userId);
    return this.consultas.detalle(id, distributorId);
  }

  @Patch(':id/reopen')
  @Idempotent()
  @ApiOperation({
    summary: 'Reabrir una rendición presentada',
    description:
      'Sólo una presentada: una aprobada ya movió dinero a una caja y se corrige anulando el movimiento y ajustando la deducción.',
  })
  @ApiParam({ name: 'id', description: 'Rendición UUID' })
  @ApiOkResponse({ type: DriverSettlementDetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La rendición no está presentada' })
  async reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<DriverSettlementDetailDto> {
    await this.rendiciones.reabrir(id, distributorId);
    return this.consultas.detalle(id, distributorId);
  }
}
