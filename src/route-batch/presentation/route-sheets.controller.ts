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
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { RouteSheetEditingService } from '../application/route-sheet-editing.service';
import { RouteSheetLifecycleService } from '../application/route-sheet-lifecycle.service';
import { RouteSheetQueryService } from '../application/route-sheet-query.service';
import { RouteSheetPdfService } from '../application/route-sheet-pdf.service';
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
@ApiTags('Route sheets (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'route-sheets', version: '2' })
export class RouteSheetsController {
  constructor(
    private readonly editing: RouteSheetEditingService,
    private readonly lifecycle: RouteSheetLifecycleService,
    private readonly query: RouteSheetQueryService,
    private readonly pdfs: RouteSheetPdfService,
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
      'En la posición pedida o, sin posición, en la inserción más barata que respeta franjas y capacidad.',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND}; o el pedido no existe o es de otra distribuidora (ORDER_NOT_FOUND)`,
  })
  @ApiConflictResponse({
    description: `${VERSION}; pedido ya en otra hoja o lote, que no es de ese día o no está pendiente, o que no entra (ROUTE_STOP_NOT_FEASIBLE): en la posición pedida o en ninguna, por franja (salvo acceptLateStops), capacidad del vehículo o máximo de paradas`,
  })
  async agregar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddRouteSheetStopDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetDto> {
    await this.editing.agregar(distributorId, id, body);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Delete(':id/stops/:orderId')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Quitar una parada',
    description:
      'Borrado lógico de la parada (motivo `admin`): el pedido vuelve a «Sin asignar».',
  })
  @ApiOkResponse({ type: RouteSheetDto })
  @ApiBadRequestResponse({ description: BAD })
  @ApiNotFoundResponse({
    description: `${NOT_FOUND}; o el pedido no es parada de la hoja (ROUTE_STOP_NOT_FOUND)`,
  })
  @ApiConflictResponse({ description: VERSION })
  async quitar(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: VersionRouteSheetDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetDto> {
    await this.editing.quitar(distributorId, id, orderId, body.version);
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
      'Exige chofer y vehículo habilitados y sin otra hoja ese día, al menos una parada, la carga dentro de la capacidad y las paradas en franja (o `acceptLateStops`). Le da número a la hoja y congela la ETA prometida. NO asigna los pedidos: siguen pendientes y retenidos hasta que el chofer la inicie.',
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
      'Vuelve a borrador para editarla. Sólo si no se inició y el día no está cerrado.',
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
  ): Promise<RouteSheetDto> {
    await this.lifecycle.reabrir(distributorId, id, body.version);
    return this.query.detalle(distributorId, id);
  }

  @Permiso('despacho.gestionar')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Cancelar la hoja',
    description:
      'Borrador o confirmada que no se inició: queda `dissolved` (`admin`), las paradas salen y los pedidos vuelven al despacho del día.',
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
  ): Promise<RouteSheetDto> {
    await this.lifecycle.cancelar(distributorId, id, body.version);
    return this.query.detalle(distributorId, id);
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
}
