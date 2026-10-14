import {
  Body,
  Controller,
  BadRequestException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { IdempotencyKeyObligatoria } from '../../stock/presentation/idempotency-key-obligatoria.decorator';
import { CancelTruckLoadUseCase } from '../application/cancel-truck-load.use-case';
import { CloseTruckLoadUseCase } from '../application/close-truck-load.use-case';
import { DepartTruckLoadUseCase } from '../application/depart-truck-load.use-case';
import { OpenTruckLoadUseCase } from '../application/open-truck-load.use-case';
import { ReloadTruckLoadUseCase } from '../application/reload-truck-load.use-case';
import { ReturnTruckLoadUseCase } from '../application/return-truck-load.use-case';
import { StockControlSettingsService } from '../application/stock-control-settings.service';
import { TruckLoadAccessService } from '../application/truck-load-access.service';
import { TruckLoadQueryService } from '../application/truck-load-query.service';
import { UpdateTruckLoadItemsUseCase } from '../application/update-truck-load-items.use-case';
import {
  CancelTruckLoadDto,
  CloseTruckLoadDto,
  CreateTruckLoadDto,
  MyTruckLoadDto,
  QueryTruckLoadDto,
  ReloadTruckLoadDto,
  ReturnTruckLoadDto,
  StockControlSettingsDto,
  TruckLoadPageDto,
  TruckLoadResponseDto,
  TruckStockDto,
  UpdateTruckLoadItemsDto,
} from '../dto/truck-load.dto';

const NO_ENCONTRADA = 'No existe o es de otra distribuidora';
const ESTADO_INVALIDO =
  'La carga no está en un estado que lo permita (conflicto de estado)';

/**
 * Carga y rendición del camión (CU de M-C parte 3): abrir la carga del día,
 * cargar, confirmar la salida, reponer en ruta, declarar la vuelta y cerrar la
 * rendición. Todo el stock se mueve por el ledger.
 */
@ApiTags('Stock · Carga del camión')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('truck-loads')
export class TruckLoadController {
  constructor(
    private readonly open: OpenTruckLoadUseCase,
    private readonly updateItems: UpdateTruckLoadItemsUseCase,
    private readonly depart: DepartTruckLoadUseCase,
    private readonly reload: ReloadTruckLoadUseCase,
    private readonly returned: ReturnTruckLoadUseCase,
    private readonly close: CloseTruckLoadUseCase,
    private readonly cancel: CancelTruckLoadUseCase,
    private readonly queries: TruckLoadQueryService,
    private readonly settings: StockControlSettingsService,
    private readonly access: TruckLoadAccessService,
  ) {}

  @Get('mine')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Mi carga: la carga abierta del chofer',
    description:
      'Devuelve la carga abierta del chofer que pide (en carga, en ruta o devuelta) con lo esperado en vivo, y si la ' +
      'distribuidora exige carga abierta para recibir pedidos. `load` es null si no tiene.',
  })
  @ApiOkResponse({ type: MyTruckLoadDto })
  mine(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<MyTruckLoadDto> {
    return this.queries.miCarga(distributorId, userId);
  }

  @Get('settings')
  @ApiOperation({
    summary: 'Parámetros del control de stock del camión',
    description:
      '`requireOpenTruckLoad` (por defecto false): si es true, un chofer sin carga abierta no recibe ofertas ni acepta pedidos.',
  })
  @ApiOkResponse({ type: StockControlSettingsDto })
  settingsGet(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StockControlSettingsDto> {
    return this.settings.obtener(distributorId);
  }

  @Put('settings')
  @ApiOperation({
    summary: 'Cambiar los parámetros del control de stock del camión',
  })
  @ApiOkResponse({ type: StockControlSettingsDto })
  settingsPut(
    @Body() dto: StockControlSettingsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<StockControlSettingsDto> {
    return this.settings.guardar(distributorId, dto, actorUserId);
  }

  @Get('cars/:carId/stock')
  @ApiOperation({
    summary: 'Stock actual de un camión',
    description:
      'Llenas, vacías y defectuosas que hay hoy en el camión, por tipo de garrafa.',
  })
  @ApiParam({ name: 'carId', description: 'Vehículo UUID' })
  @ApiOkResponse({ type: TruckStockDto })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  stock(
    @Param('carId', ParseUUIDPipe) carId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TruckStockDto> {
    return this.queries.stockDeCamion(distributorId, carId);
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Abrir la carga del día de un camión y un chofer',
    description:
      'Crea la carga en estado `loading` con sus renglones y la numera. El camión tiene que estar en uso por el chofer y ' +
      'ninguno de los dos puede tener otra carga abierta. No mueve stock: sale al confirmar la salida. Acepta `Idempotency-Key`.',
  })
  @ApiCreatedResponse({ type: TruckLoadResponseDto })
  @ApiBadRequestResponse({
    description:
      'El camión no está en uso por el chofer o los renglones son inválidos',
  })
  @ApiNotFoundResponse({
    description: 'Camión, chofer, ayudante, depósito o garrafa inexistente',
  })
  @ApiConflictResponse({
    description: 'El camión o el chofer ya tienen una carga abierta',
  })
  async create(
    @Body() dto: CreateTruckLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<TruckLoadResponseDto> {
    const id = await this.open.execute(dto, distributorId, actorUserId);
    return this.queries.detalle(id, distributorId);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar las cargas por fecha, camión, chofer y estado',
  })
  @ApiOkResponse({ type: TruckLoadPageDto })
  list(
    @Query() query: QueryTruckLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TruckLoadPageDto> {
    return this.queries.listar(distributorId, query);
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary:
      'Ver una carga con renglones, esperado, diferencias, movimientos y efectivo',
    description:
      'Mientras la carga está abierta, lo entregado y lo esperado se calculan en vivo desde el libro; al cerrar quedan ' +
      'congelados. Un chofer sólo ve las suyas. `cash` es informativo (la caja todavía no existe).',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: TruckLoadResponseDto })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TruckLoadResponseDto> {
    return this.queries.detalle(
      id,
      distributorId,
      await this.access.alcanceDe(user),
    );
  }

  @Put(':id/items')
  @ApiOperation({
    summary: 'Reemplazar los renglones de una carga que todavía no salió',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: TruckLoadResponseDto })
  @ApiBadRequestResponse({ description: 'Renglones inválidos' })
  @ApiConflictResponse({ description: ESTADO_INVALIDO })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async items(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTruckLoadItemsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TruckLoadResponseDto> {
    await this.updateItems.execute(id, dto, distributorId);
    return this.queries.detalle(id, distributorId);
  }

  @Patch(':id/depart')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @Idempotent()
  @ApiOperation({
    summary: 'Confirmar la salida del camión (loading -> on_route)',
    description:
      'El ledger pasa lo cargado del depósito de origen al camión (`truck_load`), en una transacción: si no alcanza el stock no ' +
      'sale nada. Lo puede hacer el administrador o el chofer de la carga. Acepta `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: TruckLoadResponseDto })
  @ApiBadRequestResponse({
    description:
      'Carga vacía, camión con garrafas o stock insuficiente en el depósito',
  })
  @ApiConflictResponse({ description: ESTADO_INVALIDO })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async departAction(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TruckLoadResponseDto> {
    const alcance = await this.access.alcanceDe(user);
    await this.depart.execute(id, distributorId, user.user_id, alcance);
    return this.queries.detalle(id, distributorId, alcance);
  }

  @Patch(':id/reload')
  @IdempotencyKeyObligatoria()
  @ApiOperation({
    summary: 'Reposición en ruta: más llenas del depósito al camión',
    description:
      'Sólo con la carga en ruta. Suma a `reloadedFull` y mueve las llenas del depósito de origen al camión. **Exige** el header `Idempotency-Key` (400 sin él): repetirla suma otra vez.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: TruckLoadResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sin `Idempotency-Key`, no alcanza el stock del depósito o la carga pasaría de 20 tipos de garrafa',
  })
  @ApiConflictResponse({ description: 'La carga no está en ruta' })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async reloadAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReloadTruckLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<TruckLoadResponseDto> {
    // A diferencia de salir o cerrar, repetir una reposición suma otra vez: sin
    // la clave un reintento de red duplicaría el movimiento.
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'La reposición exige el header Idempotency-Key (UUID v4): sin él un reintento sumaría las garrafas dos veces',
      );
    }
    await this.reload.execute(id, dto, distributorId, actorUserId);
    return this.queries.detalle(id, distributorId);
  }

  @Patch(':id/return')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Declarar lo que vuelve en el camión (on_route -> returned)',
    description:
      'El chofer o el administrador declaran las llenas y vacías que vuelven, de TODAS las garrafas de la carga. No mueve ' +
      'stock; la respuesta muestra lo esperado y la diferencia. Se puede volver a declarar hasta cerrar.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: TruckLoadResponseDto })
  @ApiBadRequestResponse({ description: 'Declaración incompleta' })
  @ApiConflictResponse({
    description:
      'La carga no está en ruta ni devuelta, o el chofer tiene pedidos en curso',
  })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async returnAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnTruckLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TruckLoadResponseDto> {
    const alcance = await this.access.alcanceDe(user);
    await this.returned.execute(id, dto, distributorId, alcance);
    return this.queries.detalle(id, distributorId, alcance);
  }

  @Patch(':id/close')
  @Idempotent()
  @ApiOperation({
    summary:
      'Cerrar la rendición (returned -> closed | closed_with_difference)',
    description:
      'En una transacción: devuelve lo declarado del camión al depósito (`truck_return`), registra la diferencia como merma ' +
      '(`shrinkage`) o sobrante (`adjustment`) y deja el camión en cero. Con diferencia, `differenceNote` es obligatoria y ' +
      'la carga queda `closed_with_difference`. Acepta `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: TruckLoadResponseDto })
  @ApiBadRequestResponse({ description: 'Diferencia sin nota' })
  @ApiConflictResponse({
    description:
      'La carga no está devuelta, o se entregaron garrafas después de declarar la vuelta',
  })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async closeAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseTruckLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<TruckLoadResponseDto> {
    await this.close.execute(id, dto, distributorId, actorUserId);
    return this.queries.detalle(id, distributorId);
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Cancelar una carga que todavía no salió',
    description:
      'Sólo en `loading`: todavía no se movió stock, así que sólo libera al camión y al chofer.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: TruckLoadResponseDto })
  @ApiConflictResponse({ description: ESTADO_INVALIDO })
  @ApiNotFoundResponse({ description: NO_ENCONTRADA })
  async cancelAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTruckLoadDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<TruckLoadResponseDto> {
    await this.cancel.execute(id, dto.reason, distributorId, actorUserId);
    return this.queries.detalle(id, distributorId);
  }
}
