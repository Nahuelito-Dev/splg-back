import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { RouteSheetEditingService } from '../application/route-sheet-editing.service';
import { RouteSheetLifecycleService } from '../application/route-sheet-lifecycle.service';
import { RouteSheetQueryService } from '../application/route-sheet-query.service';
import { RouteSheetPathService } from '../application/route-sheet-path.service';
import { RouteSheetPdfService } from '../application/route-sheet-pdf.service';
import { RouteSheetPathDto } from './dto/route-sheet-path.dto';
import { contentDisposition } from '../../s3/content-disposition';
import { DownloadDisposition } from '../../s3/dto/download-link.dto';
import {
  AddRouteSheetStopDto,
  ConfirmRouteSheetDto,
  CreateRouteSheetDto,
  MoveRouteSheetStopDto,
  QueryRouteSheetsDto,
  SetRouteSheetSequenceDto,
  UpdateRouteSheetDto,
  VersionRouteSheetDto,
} from './dto/route-sheet-request.dto';
import {
  LoadSuggestionDto,
  RouteSheetDto,
  RouteSheetMoveResponseDto,
  RouteSheetNotConfirmableDto,
  RouteSheetOptimizeResponseDto,
  RouteSheetPageDto,
} from './dto/route-sheet-response.dto';
import { RequiereAlcanceDeSoporte } from '../../common/decorators/alcance-de-soporte.decorator';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { RouteSheetCloseService } from '../application/route-sheet-close.service';
import { RouteSheetExecutionQueryService } from '../application/route-sheet-execution-query.service';
import { RouteSheetInProgressEditingService } from '../application/route-sheet-in-progress-editing.service';
import { RouteSheetStartService } from '../application/route-sheet-start.service';
import {
  RouteSheetStopsService,
  resultadoParaLaHoja,
} from '../application/route-sheet-stops.service';
import {
  CloseRouteSheetDto,
  CloseRouteSheetResponseDto,
  FailedStopDto,
  RouteSheetExecutionDto,
  RouteSheetStopActionResponseDto,
  StartRouteSheetDto,
  StartRouteSheetResponseDto,
} from './dto/route-sheet-execution.dto';
import {
  START_CONFLICT,
  STOP_CONFLICT,
} from './driver-route-sheets.controller';
import {
  RequiereModulo,
  SinModulo,
} from '../../platform/access/requiere-modulo.decorator';

const BAD =
  'Cuerpo inválido, id que no es UUID o falta la distribuidora (super admin sin X-Distributor)';
const NOT_FOUND =
  'La hoja no existe o es de otra distribuidora (ROUTE_SHEET_NOT_FOUND)';
const VERSION =
  'Otro administrador cambió la hoja (ROUTE_SHEET_VERSION_CONFLICT), la hoja no está en borrador (ROUTE_SHEET_NOT_EDITABLE) o se está editando en otra sesión (ROUTE_SHEET_BUSY)';

/**
 * Hojas de ruta (F34): alta manual, edición con versión optimista (toda edición
 * manda `version`; 409 si cambió), confirmación, reapertura y cancelación. Cada
 * operación responde la hoja como quedó, con su versión nueva.
 */
@RequiereModulo('route_planning')
@ApiTags('Route sheets (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'route-sheets', version: '2' })
export class RouteSheetsController {
  constructor(
    private readonly editing: RouteSheetEditingService,
    private readonly lifecycle: RouteSheetLifecycleService,
    private readonly query: RouteSheetQueryService,
    private readonly pdfs: RouteSheetPdfService,
    private readonly start: RouteSheetStartService,
    private readonly stops: RouteSheetStopsService,
    private readonly close: RouteSheetCloseService,
    private readonly enCurso: RouteSheetInProgressEditingService,
    private readonly execution: RouteSheetExecutionQueryService,
    private readonly paths: RouteSheetPathService,
  ) {}

  @Permiso('despacho.gestionar')
  @Post()
  @ApiOperation({
    summary: 'Alta manual de una hoja',
    description:
      'Crea un borrador del día (abre la planificación si hacía falta) con chofer, vehículo y pedidos opcionales, en el orden dado.',
  })
  @ApiCreatedResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({
    description:
      'Chofer, vehículo o pedido inexistente o de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'Día pasado o cerrado, pedido ya en otra hoja o lote (ORDER_ALREADY_IN_ROUTE), pedido que no es de ese día o no está pendiente (ORDER_NOT_PLANNABLE), o más paradas que el máximo',
  })
  async crear(
    @Body() body: CreateRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetDto> {
    const id = await this.editing.crear(distributorId, body);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Get()
  @ApiOperation({
    summary: 'Hojas de ruta (paginado)',
    description:
      'Del día más nuevo al más viejo; filtra por día, estado y chofer.',
  })
  @ApiOkResponse({ type: RouteSheetPageDto })
  @ApiBadRequestResponse({ description: BAD })
  listar(
    @Query() q: QueryRouteSheetsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetPageDto> {
    return this.query.listar(distributorId, {
      date: q.date,
      status: q.status,
      deliveryId: q.deliveryId,
      limit: q.limit ?? 10,
      offset: q.offset ?? 0,
    });
  }

  @Permiso('despacho.gestionar')
  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Detalle de una hoja',
    description:
      'Paradas en orden con ETA, franja y carga; totales, capacidad y advertencias.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  detalle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetDto> {
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Patch(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Cambiar chofer, vehículo, salida o depósito',
    description: 'Sólo en borrador. Recalcula horas y totales.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND}; o chofer, vehículo o depósito de otra distribuidora`,
  })
  @ApiConflictResponse({
    description: `${VERSION}; o el chofer o el vehículo ya tienen otra hoja confirmada ese día`,
  })
  async editar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetDto> {
    await this.editing.editar(distributorId, id, body);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Post(':id/stops')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Agregar una parada',
    description:
      'En la posición pedida o, sin posición, en la inserción más barata que respeta franjas y capacidad. Con la hoja EN CURSO (E4): el pedido (del día, pendiente y sin chofer) se le asigna al chofer y entra en la cola de lo que falta (`position` 1 = la próxima después de la parada en camino; sin posición, la que menos atrasa); `lock` y `acceptLateStops` no aplican y al chofer se le avisa (`route-sheet:changed` + push).',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND}; o el pedido no existe o es de otra distribuidora (ORDER_NOT_FOUND)`,
  })
  @ApiConflictResponse({
    description: `${VERSION}; pedido ya en otra hoja o lote, que no es de ese día o no está pendiente, o que no entra (ROUTE_STOP_NOT_FEASIBLE): en la posición pedida o en ninguna, por franja (salvo acceptLateStops), capacidad del vehículo o máximo de paradas. En curso: el pedido ya no está disponible (lo tomó otro chofer en el medio)`,
  })
  async agregar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddRouteSheetStopDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RouteSheetDto> {
    const hoja = await this.query.detalleSinMapear(distributorId, id);
    if (hoja.status === RouteBatchStatus.ASSIGNED) {
      await this.enCurso.agregarEnCurso(distributorId, id, body, userId);
    } else {
      await this.editing.agregar(distributorId, id, body);
    }
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Delete(':id/stops/:orderId')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Quitar una parada',
    description:
      'Borrado lógico de la parada (motivo `admin`): el pedido vuelve a «Sin asignar». Con la hoja EN CURSO (E4): sólo una parada pendiente (no la que está en camino: 409 ROUTE_STOP_NOT_PENDING); el pedido se le libera al chofer y queda esperando que el admin lo reprograme, lo asigne o lo cancele (no vuelve al despacho común), la cola se reordena y al chofer se le avisa.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND}; o el pedido no es parada de la hoja (ROUTE_STOP_NOT_FOUND)`,
  })
  @ApiConflictResponse({
    description: `${VERSION}; en curso, ROUTE_STOP_NOT_PENDING (la parada ya se entregó, está en camino o salió)`,
  })
  async quitar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: VersionRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RouteSheetDto> {
    const hoja = await this.query.detalleSinMapear(distributorId, id);
    if (hoja.status === RouteBatchStatus.ASSIGNED) {
      await this.enCurso.quitarEnCurso(
        distributorId,
        id,
        orderId,
        body.version,
        userId,
      );
    } else {
      await this.editing.quitar(distributorId, id, orderId, body.version);
    }
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Post(':id/stops/:orderId/move')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Mover una parada a otra hoja del mismo día',
    description:
      'Manda la versión de las dos hojas. Sin posición, la inserción más barata en la de destino. Responde las dos hojas.',
  })
  @ApiOkResponse({ type: RouteSheetMoveResponseDto })
  @ApiBadRequestResponse({
    description: `${BAD}; o la hoja de destino es la misma (ROUTE_SHEET_SAME_TARGET)`,
  })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND} (cualquiera de las dos); o el pedido no es parada de la hoja`,
  })
  @ApiConflictResponse({
    description: `${VERSION} (cualquiera de las dos); hojas de días distintos (ROUTE_SHEET_OTHER_DAY) o no entra en la de destino (ROUTE_STOP_NOT_FEASIBLE: franja salvo acceptLateStops, capacidad o máximo de paradas)`,
  })
  async mover(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: MoveRouteSheetStopDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetMoveResponseDto> {
    await this.editing.mover(distributorId, id, orderId, body);
    return {
      source: await this.query.detalle(distributorId, id),
      target: await this.query.detalle(distributorId, body.targetSheetId),
    };
  }

  @Permiso('despacho.gestionar')
  @Put(':id/sequence')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Orden manual',
    description:
      'Exactamente las paradas de la hoja en el orden nuevo; `locked` fija posiciones. Queda `optimizationMethod: manual`.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({
    description: `${BAD}; o no son exactamente las paradas de la hoja (ROUTE_SHEET_SEQUENCE_INVALID)`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: VERSION })
  async ordenar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetRouteSheetSequenceDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetDto> {
    await this.editing.ordenar(distributorId, id, body);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Post(':id/optimize')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Re-optimizar el orden',
    description:
      'Vecino más cercano con franjas + 2-opt / Or-opt, respetando las fijadas. Devuelve cómo estaba y cómo quedó.',
  })
  @ApiOkResponse({ type: RouteSheetOptimizeResponseDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: VERSION })
  async optimizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VersionRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetOptimizeResponseDto> {
    const r = await this.editing.optimizar(distributorId, id, body.version);
    return { ...r, sheet: await this.query.detalle(distributorId, id) };
  }

  @Permiso('despacho.gestionar')
  @Post(':id/confirm')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Confirmar la hoja',
    description:
      'Exige chofer y vehículo habilitados y sin otra hoja ese día, al menos una parada, la carga dentro de la capacidad y las paradas en franja (o `acceptLateStops`). Le da número a la hoja y congela la ETA prometida. La hoja confirmada es del chofer: si es de hoy, sus pedidos le quedan asignados en el acto (sin que tenga que aceptar nada; `assignedAt`); si es de otro día, quedan retenidos para él y se le asignan al empezar ese día. Un pedido que ya no está libre sale de la hoja.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    type: RouteSheetNotConfirmableDto,
    description: `${VERSION}; o no cumple las reglas (ROUTE_SHEET_NOT_CONFIRMABLE, con \`violations[]\`)`,
  })
  async confirmar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConfirmRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RouteSheetDto> {
    await this.lifecycle.confirmar(distributorId, id, body, userId);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Post(':id/reopen')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Reabrir una hoja confirmada',
    description:
      'Vuelve a borrador para editarla. Sólo si el viaje no se inició y el día no está cerrado. Si los pedidos ya estaban asignados al chofer (hoja de hoy), se le liberan y vuelven a quedar retenidos por la hoja en borrador.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description: `${VERSION}; no está confirmada o ya se inició; o el día está cerrado (ROUTE_PLAN_CLOSED)`,
  })
  async reabrir(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VersionRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RouteSheetDto> {
    await this.lifecycle.reabrir(distributorId, id, body.version, userId);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Cancelar la hoja',
    description:
      'Borrador o confirmada cuyo viaje no se inició: queda `dissolved` (`admin`), las paradas salen y los pedidos (liberados del chofer si ya se le habían asignado) vuelven al despacho del día.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description: `${VERSION}; o ya se inició o está cerrada`,
  })
  async cancelar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VersionRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RouteSheetDto> {
    await this.lifecycle.cancelar(distributorId, id, body.version, userId);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Get(':id/path')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Recorrido por calles de la hoja',
    description:
      'Para el mapa del detalle: depósito → paradas activas en el orden vigente → depósito, por calles, con la polilínea codificada y un tramo por parada (más la vuelta). Las paradas sin coordenadas se saltean y vienen en `skippedOrderIds`; sin paradas con coordenadas (o sin depósito ubicado y con una sola parada) responde 200 con el recorrido vacío (`provider: null`). El depósito es el mismo que usa el cálculo de horarios de la hoja: el de la hoja; si la hoja no tiene, el predeterminado de la distribuidora. Si el de la hoja está dado de baja o sin ubicación no se reemplaza por otro (los horarios tampoco salen de otro depósito): `warehouse: null` y el recorrido va de la primera a la última parada. Lo calcula el servidor con la Routes API de Google y su propia clave (de a 25 paradas intermedias por consulta, unidas), y si Google falla o no hay clave, con OSRM. Se guarda por hoja y firma de sus paradas y coordenadas: mientras la hoja no cambie no se vuelve a consultar al proveedor (un día; el de OSRM, 10 minutos, para volver a Google en cuanto responda). Cada consulta a Google cuenta contra un cupo diario por distribuidora (500, `ROUTE_SHEET_PATH_DAILY_LIMIT_PER_DISTRIBUTOR`); OSRM y lo guardado no cuentan.',
  })
  @ApiOkResponse({ type: RouteSheetPathDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiResponse({
    status: 429,
    description:
      'La distribuidora llegó al máximo de recorridos del día (ROUTE_PATH_DAILY_LIMIT)',
  })
  @ApiResponse({
    status: 502,
    description: 'Ningún servicio de mapas respondió (ROUTE_PROVIDER_FAILED)',
  })
  @ApiResponse({
    status: 503,
    description:
      'No hay servicio de mapas configurado (ROUTE_PROVIDER_UNAVAILABLE)',
  })
  recorrido(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetPathDto> {
    return this.paths.recorrido(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Get(':id/load-suggestion')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Carga sugerida por garrafa',
    description:
      'Llenas a cargar y vacías que vuelven del canje, para precargar la carga del camión.',
  })
  @ApiOkResponse({ type: LoadSuggestionDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  cargaSugerida(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<LoadSuggestionDto> {
    return this.query.cargaSugerida(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Get(':id/pdf')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Hoja de ruta en PDF',
    description:
      'Número, fecha, chofer, patente, salida, paradas en orden (cliente, dirección, teléfono, franja, llegada, garrafas), totales y firma. Un borrador sale marcado como tal.',
  })
  // Modo soporte: el PDF lleva nombres, direcciones y teléfonos: pide `files`.
  @RequiereAlcanceDeSoporte('files')
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'El PDF (A4)',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StreamableFile> {
    const doc = await this.pdfs.pdf(distributorId, id);
    return new StreamableFile(doc.contenido, {
      type: 'application/pdf',
      disposition: contentDisposition(
        doc.nombre,
        DownloadDisposition.ATTACHMENT,
      ),
      length: doc.contenido.length,
    });
  }

  // ───────────────────────── ejecución (E4) ─────────────────────────

  // Iniciar es empezar algo nuevo: con la hoja de ruta apagada no se inicia
  // una hoja confirmada; sólo termina la que ya está en curso (§7.3).
  @Permiso('despacho.gestionar')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Post(':id/start')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Iniciar viaje',
    description:
      'Lo inicia el chofer de la hoja (o un admin en su nombre) con la carga del camión hecha: la hoja pasa a en curso (`assigned`) y a todos los clientes se les avisa por push que su pedido está en camino, con la franja estimada. Si los pedidos todavía no se le habían asignado al chofer, se asignan acá (saltando la retención sólo de ESTA hoja y SU chofer; lo que ya no está libre sale). Exige hoja confirmada y del día, el vehículo de la hoja en uso por el chofer, chofer habilitado y la carga obligatoria en ese vehículo, ya salida del depósito y completa (o el faltante aceptado). Idempotente (`alreadyStarted: true`). Para el chofer es lo mismo que `POST /v2/driver/route-sheets/:id/start`; otra hoja que no es suya es 404.',
  })
  @ApiOkResponse({ type: StartRouteSheetResponseDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: START_CONFLICT })
  iniciar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StartRouteSheetDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StartRouteSheetResponseDto> {
    return this.start.iniciar(
      distributorId,
      id,
      { userId: user.user_id, esChofer: user.role === RoleType.DELIVERY },
      body.acknowledgeShortages === true,
    );
  }

  @SinModulo(
    'La hoja del día en curso se termina aunque se apague la hoja de ruta',
  )
  @Permiso('despacho.gestionar')
  @Get(':id/execution')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Seguimiento de la hoja',
    description:
      'La hoja con el avance de cada parada (pendiente, en camino, entregada, no entregada, fuera de la hoja, con motivo y hora), la hora estimada vigente contra la prometida, la franja avisada al cliente, la parada en camino y la última posición del chofer. Sólo lectura (sirve en modo soporte). En vivo: `route-sheet:*` en el socket del panel.',
  })
  @ApiOkResponse({ type: RouteSheetExecutionDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  seguimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetExecutionDto> {
    return this.execution.seguimiento(distributorId, id);
  }

  @SinModulo(
    'La hoja del día en curso se termina aunque se apague la hoja de ruta',
  )
  @Permiso('despacho.gestionar')
  @Post(':id/stops/:orderId/failed')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: '«No pudo entregar» (en nombre del chofer)',
    description:
      'Igual que el chofer: primer intento, la parada pasa al final de la cola; segundo, sale de la hoja y el pedido se reprograma solo para el día hábil siguiente (nunca vuelve al despacho común). Al cliente se le avisa por push y al chofer por socket y push.',
  })
  @ApiOkResponse({ type: RouteSheetStopActionResponseDto })
  @ApiBadRequestResponse({
    description: `${BAD}; \`reason\` fuera de la lista o \`reason: other\` sin \`note\``,
  })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND}; o el pedido no es parada activa (ROUTE_STOP_NOT_FOUND)`,
  })
  @ApiConflictResponse({ description: STOP_CONFLICT })
  async noEntregada(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: FailedStopDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetStopActionResponseDto> {
    return resultadoParaLaHoja(
      await this.stops.noEntregada(
        distributorId,
        id,
        orderId,
        { userId, esChofer: false },
        body,
      ),
    );
  }

  @SinModulo(
    'La hoja del día en curso se termina aunque se apague la hoja de ruta',
  )
  @Permiso('despacho.gestionar')
  @Post(':id/close')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Cerrar la hoja en curso',
    description:
      'Las paradas pendientes salen (`sheet_closed`, con el motivo) y sus pedidos se reprograman solos para el día hábil siguiente (no vuelven al despacho común); la hoja queda cerrada (`completed`, `closeNote`). Idempotente (`alreadyClosed: true`).',
  })
  @ApiOkResponse({ type: CloseRouteSheetResponseDto })
  @ApiBadRequestResponse({
    description: `${BAD}; \`reason\` de 5 a 280 caracteres`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description: 'ROUTE_SHEET_NOT_IN_PROGRESS (no se inició), ROUTE_SHEET_BUSY',
  })
  cerrar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CloseRouteSheetDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CloseRouteSheetResponseDto> {
    return this.close.cerrar(
      distributorId,
      id,
      { userId, esChofer: false },
      body.reason,
    );
  }
}
