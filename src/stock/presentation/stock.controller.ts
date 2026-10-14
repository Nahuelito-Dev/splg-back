import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { Auth } from '../../common/decorators/auth.decorator';
import { RoleType } from '../../common/constants/role-type.enum';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { exigirIdempotencyKey } from './exigir-idempotency-key';
import { IdempotencyKeyObligatoria } from './idempotency-key-obligatoria.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { InitialCountUseCase } from '../application/initial-count.use-case';
import { ReapplyDeliveriesUseCase } from '../application/reapply-deliveries.use-case';
import type { ResultadoDeReaplicacion } from '../application/reapply-deliveries.use-case';
import { ReconciliationAdjustmentUseCase } from '../application/reconciliation-adjustment.use-case';
import { ReverseBatchUseCase } from '../application/reverse-batch.use-case';
import { StockAdjustmentUseCase } from '../application/stock-adjustment.use-case';
import { StockLocationService } from '../application/stock-location.service';
import { StockQueryService } from '../application/stock-query.service';
import { StockReconciliationService } from '../application/stock-reconciliation.service';
import { StockThresholdService } from '../application/stock-threshold.service';
import { StockTransferUseCase } from '../application/stock-transfer.use-case';
import {
  QueryStockAdjustmentDto,
  QueryStockBalanceDto,
  QueryStockMovementDto,
} from '../dto/query-stock.dto';
import {
  CreateAdjustmentDto,
  CreateReconciliationAdjustmentDto,
  CreateInitialCountDto,
  CreateTransferDto,
  ReverseBatchDto,
} from '../dto/stock-operations.dto';
import {
  ReapplyDeliveriesResultDto,
  StockAdjustmentPageDto,
  StockAdjustmentResponseDto,
  StockBalanceDto,
  StockLocationDto,
  StockMovementPageDto,
  StockOperationResultDto,
  StockReconciliationDto,
  StockSummaryDto,
  StockThresholdDto,
} from '../dto/stock-response.dto';
import { UpsertThresholdsDto } from '../dto/stock-threshold.dto';

/**
 * Stock físico por ubicación (CU-208 a CU-213 y CU-224): saldos, libro de
 * movimientos, conteo inicial, ajustes, transferencias, umbrales y
 * conciliación. Las escrituras que mueven stock llevan `Idempotency-Key`.
 */
@ApiTags('Stock')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('stock')
export class StockController {
  constructor(
    private readonly queries: StockQueryService,
    private readonly locations: StockLocationService,
    private readonly thresholds: StockThresholdService,
    private readonly reconciliation: StockReconciliationService,
    private readonly reapply: ReapplyDeliveriesUseCase,
    private readonly transfers: StockTransferUseCase,
    private readonly adjustments: StockAdjustmentUseCase,
    private readonly initialCounts: InitialCountUseCase,
    private readonly reversals: ReverseBatchUseCase,
    private readonly reconciliationAdjustments: ReconciliationAdjustmentUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Saldos por ubicación, tipo de garrafa y condición (CU-208)',
  })
  @ApiOkResponse({ type: StockBalanceDto, isArray: true })
  saldos(
    @Query() query: QueryStockBalanceDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockBalanceDto[]> {
    return this.queries.saldos(distributorId, query);
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Resumen galpón vs camiones por tipo de garrafa (CU-208)',
    description:
      'Llenas, vacías y defectuosas en depósitos y en vehículos, lo reservado ' +
      'por pedidos abiertos, el vendible y el mínimo configurado.',
  })
  @ApiOkResponse({ type: StockSummaryDto, isArray: true })
  resumen(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockSummaryDto[]> {
    return this.queries.resumen(distributorId);
  }

  @Get('locations')
  @ApiOperation({
    summary: 'Ubicaciones de stock: depósitos y vehículos con ubicación',
  })
  @ApiOkResponse({ type: StockLocationDto, isArray: true })
  ubicaciones(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockLocationDto[]> {
    return this.locations.listar(distributorId);
  }

  @Get('movements')
  @ApiOperation({
    summary: 'Libro de movimientos de stock, paginado (CU-209)',
    description:
      'Filtros por tipo de garrafa, ubicación (origen o destino), motivo, ' +
      'tipo de referencia, lote y fechas (días argentinos, `to` inclusivo).',
  })
  @ApiOkResponse({ type: StockMovementPageDto })
  @ApiBadRequestResponse({ description: 'Fechas inválidas' })
  movimientos(
    @Query() query: QueryStockMovementDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockMovementPageDto> {
    return this.queries.movimientos(distributorId, query);
  }

  @Post('movements/batches/:batchId/reverse')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Contraasentar una transferencia',
    description:
      'El libro no se edita: se agregan movimientos inversos (`reversal`) que ' +
      'apuntan a los originales. Sólo transferencias; un ajuste se corrige con otro ajuste. **Exige** `Idempotency-Key` (400 sin ella). ' +
      'No se contraasienta hacia un camión (409): el stock del camión entra sólo por la carga del día.',
  })
  @ApiParam({ name: 'batchId', description: 'Lote de la transferencia' })
  @ApiCreatedResponse({ type: StockOperationResultDto })
  @ApiNotFoundResponse({ description: 'El lote no existe en la distribuidora' })
  @ApiBadRequestResponse({ description: 'El lote no es una transferencia' })
  @ApiConflictResponse({
    description:
      'Ya fue contraasentado, o las garrafas ya no están donde estaban',
  })
  async contraasentar(
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() dto: ReverseBatchDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StockOperationResultDto> {
    exigirIdempotencyKey(idempotencyKey, 'Contraasentar');
    const nuevo = await this.reversals.execute(
      batchId,
      dto.notes,
      distributorId,
      actorUserId,
    );
    return this.resultado(distributorId, nuevo);
  }

  @Post('transfers')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary:
      'Transferir stock entre depósitos o entre un depósito y un vehículo (CU-212)',
    description:
      '**Exige** el header `Idempotency-Key` (400 sin él): un reintento sin clave duplicaría el movimiento.',
  })
  @ApiCreatedResponse({ type: StockOperationResultDto })
  @ApiBadRequestResponse({
    description: 'Stock insuficiente en el origen, o ubicaciones inválidas',
  })
  @ApiNotFoundResponse({
    description:
      'Depósito, vehículo o garrafa inexistente o de otra distribuidora',
  })
  async transferir(
    @Body() dto: CreateTransferDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StockOperationResultDto> {
    exigirIdempotencyKey(idempotencyKey, 'La transferencia');
    const batchId = await this.transfers.execute(
      dto,
      distributorId,
      actorUserId,
    );
    return this.resultado(distributorId, batchId);
  }

  @Post('initial-counts')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Conteo inicial de un depósito',
    description:
      '**Exige** `Idempotency-Key` (400 sin ella). Carga lo que hay físicamente. Registra un ajuste `initial_count` con las ' +
      'diferencias contra el saldo actual y el vendible acompaña a las llenas. ' +
      'Una vez por depósito.',
  })
  @ApiCreatedResponse({ type: StockAdjustmentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sin diferencias, o el vendible quedaría negativo (hay pedidos abiertos que reservan esas llenas)',
  })
  @ApiNotFoundResponse({ description: 'Depósito o garrafa inexistente' })
  @ApiConflictResponse({
    description: 'El depósito ya tiene su conteo inicial',
  })
  async conteoInicial(
    @Body() dto: CreateInitialCountDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StockAdjustmentResponseDto> {
    exigirIdempotencyKey(idempotencyKey, 'El conteo inicial');
    const id = await this.initialCounts.execute(
      dto,
      distributorId,
      actorUserId,
    );
    return this.queries.ajuste(id, distributorId);
  }

  @Post('adjustments')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Registrar un ajuste o una merma de stock (CU-213)',
    description:
      '**Exige** `Idempotency-Key` (400 sin ella). Motivos: corrección de conteo, merma, fuga, rotura (llena a defectuosa), ' +
      'pérdida y encontrado. Nota obligatoria; el número es correlativo por ' +
      'distribuidora. Si toca llenas, el vendible acompaña y nunca queda negativo.',
  })
  @ApiCreatedResponse({ type: StockAdjustmentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sin nota, signo inválido para el motivo, saldo o vendible negativo',
  })
  @ApiNotFoundResponse({ description: 'Ubicación o garrafa inexistente' })
  async ajustar(
    @Body() dto: CreateAdjustmentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StockAdjustmentResponseDto> {
    exigirIdempotencyKey(idempotencyKey, 'El ajuste');
    const id = await this.adjustments.execute(dto, distributorId, actorUserId);
    return this.queries.ajuste(id, distributorId);
  }

  @Get('adjustments')
  @ApiOperation({ summary: 'Listar los ajustes de stock, paginado' })
  @ApiOkResponse({ type: StockAdjustmentPageDto })
  ajustes(
    @Query() query: QueryStockAdjustmentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockAdjustmentPageDto> {
    return this.queries.ajustes(distributorId, query);
  }

  @Get('adjustments/:id')
  @ApiOperation({ summary: 'Ver el detalle de un ajuste de stock' })
  @ApiParam({ name: 'id', description: 'Ajuste UUID' })
  @ApiOkResponse({ type: StockAdjustmentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  ajuste(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockAdjustmentResponseDto> {
    return this.queries.ajuste(id, distributorId);
  }

  @Get('thresholds')
  @ApiOperation({ summary: 'Mínimos de llenas por depósito y tipo (CU-210)' })
  @ApiOkResponse({ type: StockThresholdDto, isArray: true })
  umbrales(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockThresholdDto[]> {
    return this.thresholds.listar(distributorId);
  }

  @Put('thresholds')
  @ApiOperation({
    summary: 'Configurar mínimos en lote (CU-210)',
    description:
      'Alta o cambio de varios pares depósito-tipo. Un cron diario (8:00 ART) ' +
      'avisa por email a los administradores cuando las llenas bajan del mínimo.',
  })
  @ApiOkResponse({ type: StockThresholdDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Depósito o garrafa inexistente' })
  configurarUmbrales(
    @Body() dto: UpsertThresholdsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockThresholdDto[]> {
    return this.thresholds.upsert(dto, distributorId);
  }

  @Get('reconciliation')
  @ApiOperation({
    summary: 'Conciliar el vendible contra el físico (CU-224)',
    description:
      'vendible = max(0, Σ llenas en depósitos y camiones − Σ pedidos abiertos). ' +
      'Informa las diferencias, las reservas que el físico no cubre (`overReserved`, p. ej. tras una merma con pedidos abiertos) ' +
      'y las entregas sin movimiento; no corrige nada.',
  })
  @ApiOkResponse({ type: StockReconciliationDto })
  conciliar(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockReconciliationDto> {
    return this.reconciliation.conciliar(distributorId);
  }

  @Post('reconciliation/reapply-deliveries')
  @Idempotent()
  @ApiOperation({
    summary: 'Volver a descontar el físico de las entregas pendientes',
    description:
      'Para después de corregir la causa (por ejemplo, transferir llenas al ' +
      'depósito). Idempotente: no duplica lo ya descontado.',
  })
  @ApiCreatedResponse({ type: ReapplyDeliveriesResultDto })
  reaplicar(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ResultadoDeReaplicacion> {
    return this.reapply.execute(distributorId);
  }

  @Post('reconciliation/adjustments')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Corregir el vendible de una garrafa hasta la invariante',
    description:
      '**Exige** `Idempotency-Key` (400 sin ella). Ajuste de conciliación: deja `gas_cylinder.stock = max(0, llenas − reservado)` SIN tocar el físico ' +
      '(`correction` de la conciliación). Documento numerado con motivo `reconciliation` y nota ' +
      'obligatoria; no genera movimientos físicos. Con `expectedDifference` falla con 409 si la ' +
      'diferencia cambió.',
  })
  @ApiCreatedResponse({ type: StockAdjustmentResponseDto })
  @ApiBadRequestResponse({
    description: 'Sin diferencia, sin nota o sin `Idempotency-Key`',
  })
  @ApiNotFoundResponse({
    description: 'La garrafa no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({ description: 'La diferencia cambió' })
  async corregirVendible(
    @Body() dto: CreateReconciliationAdjustmentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StockAdjustmentResponseDto> {
    exigirIdempotencyKey(idempotencyKey, 'La corrección del vendible');
    const id = await this.reconciliationAdjustments.execute(
      dto,
      distributorId,
      actorUserId,
    );
    return this.queries.ajuste(id, distributorId);
  }

  private async resultado(
    distributorId: string,
    batchId: string,
  ): Promise<StockOperationResultDto> {
    return {
      batchId,
      movements: await this.queries.movimientosDelLote(distributorId, batchId),
    };
  }
}
