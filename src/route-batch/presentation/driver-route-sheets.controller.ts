import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ArrivedDto } from '../../order/dto/arrived.dto';
import { RouteSheetCloseService } from '../application/route-sheet-close.service';
import { RouteSheetExecutionQueryService } from '../application/route-sheet-execution-query.service';
import { RouteSheetStartService } from '../application/route-sheet-start.service';
import { RouteSheetStopsService } from '../application/route-sheet-stops.service';
import { RequiereModulo } from '../../platform/access/requiere-modulo.decorator';
import {
  CloseRouteSheetDto,
  CloseRouteSheetResponseDto,
  FailedStopDto,
  RouteSheetArrivedResponseDto,
  RouteSheetExecutionDto,
  RouteSheetStopActionResponseDto,
  StartRouteSheetDto,
  StartRouteSheetResponseDto,
} from './dto/route-sheet-execution.dto';

export const BAD_ID =
  'Id que no es UUID o cuerpo inválido (los mensajes de validación vienen en castellano)';
export const NOT_FOUND_CHOFER =
  'La hoja no existe, es de otra distribuidora o es de otro chofer (ROUTE_SHEET_NOT_FOUND); o el pedido no es una parada activa de la hoja (ROUTE_STOP_NOT_FOUND)';
export const START_CONFLICT =
  'ROUTE_SHEET_NOT_STARTABLE (no está confirmada o ya se cerró), ROUTE_SHEET_NOT_TODAY (no es del día), ROUTE_SHEET_CAR_NOT_IN_USE (el vehículo en uso no es el de la hoja; trae `sheetCarPatent` y `carInUsePatent`), ROUTE_SHEET_DRIVER_UNAVAILABLE (licencia, vencimientos, legajo o chofer deshabilitado; trae `reasons[]`), ROUTE_SHEET_TRUCK_LOAD_REQUIRED (el chofer no tiene la carga del camión abierta: el viaje sale siempre con su carga), ROUTE_SHEET_TRUCK_LOAD_NOT_READY (la carga no salió del depósito o ya volvió), ROUTE_SHEET_TRUCK_LOAD_OTHER_CAR (la carga está en otro vehículo), ROUTE_SHEET_SHORTAGES (faltan garrafas en el camión; trae `shortages[]`: reintentar con `acknowledgeShortages: true`), ROUTE_SHEET_NOTHING_TO_START (ningún pedido se pudo asignar), ROUTE_SHEET_BUSY (otra operación tiene la hoja)';
export const STOP_CONFLICT =
  'ROUTE_SHEET_NOT_IN_PROGRESS (la hoja no está en curso), ROUTE_STOP_NOT_PENDING (la parada ya se entregó o salió), ROUTE_SHEET_STOP_IN_PROGRESS o DRIVER_ALREADY_ON_THE_WAY (ya va en camino a otra parada; el segundo lo da el cerrojo del chofer cuando dos pedidos salen a la vez), ROUTE_SHEET_BUSY';

/**
 * La hoja de ruta del chofer (F34 E4, §9.2): ver la de hoy, iniciarla y
 * avanzar parada por parada. La entrega la confirma el cliente con el QR
 * (`POST /orders/:id/confirm-delivery`); la hoja la sigue sola. Todo es del
 * chofer autenticado: la hoja de otro (o de otra distribuidora) es 404.
 */
@ApiTags('Driver · Route sheets (v2)')
@Auth(RoleType.DELIVERY)
@Controller({ path: 'driver/route-sheets', version: '2' })
export class DriverRouteSheetsController {
  constructor(
    private readonly query: RouteSheetExecutionQueryService,
    private readonly start: RouteSheetStartService,
    private readonly stops: RouteSheetStopsService,
    private readonly close: RouteSheetCloseService,
  ) {}

  @Get('current')
  @ApiOperation({
    summary: 'Mi hoja de hoy',
    description:
      'La hoja en curso, o la de hoy confirmada (ya es del chofer: `assignedAt`), o la próxima confirmada. Paradas en orden con su avance, intentos, hora estimada, franja, renglones y la siguiente parada propuesta (`nextOrderId`). 204 si no hay ninguna.',
  })
  @ApiOkResponse({ type: RouteSheetExecutionDto })
  @ApiNoContentResponse({ description: 'No tenés hoja de ruta' })
  @ApiBadRequestResponse({ description: 'Falta la distribuidora' })
  async actual(
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RouteSheetExecutionDto | undefined> {
    const hoja = await this.query.actualDelChofer(distributorId, userId);
    if (!hoja) {
      res.status(204);
      return undefined;
    }
    return hoja;
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Una hoja mía',
    description:
      'Confirmada, en curso o cerrada (con las paradas que salieron).',
  })
  @ApiOkResponse({ type: RouteSheetExecutionDto })
  @ApiBadRequestResponse({ description: BAD_ID })
  @ApiNotFoundResponse({ description: NOT_FOUND_CHOFER })
  detalle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetExecutionDto> {
    return this.query.delChofer(distributorId, userId, id);
  }

  // Iniciar es empezar algo nuevo: exige el módulo (§7.3). Lo demás del chofer
  // opera sobre la hoja ya en curso y sigue con el módulo apagado.
  @RequiereModulo('route_planning')
  @Post(':id/start')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Iniciar viaje',
    description:
      'La hoja confirmada ya es del chofer (sus pedidos se le asignan al confirmarla o al empezar el día; si todavía no, acá). Con la carga del camión hecha (la carga mueve las garrafas del depósito al vehículo al confirmar su salida), el chofer inicia el viaje: la hoja pasa a en curso y a TODOS los clientes de la hoja se les avisa por push que su pedido está en camino, con la franja estimada (`notifiedCustomers`). Exige: hoja confirmada y del día, el vehículo de la hoja en uso, chofer habilitado y la carga (obligatoria) en ese vehículo, ya salida del depósito y completa (o el faltante aceptado con `acknowledgeShortages`). Idempotente: si ya se inició, 200 con `alreadyStarted: true`.',
  })
  @ApiOkResponse({ type: StartRouteSheetResponseDto })
  @ApiBadRequestResponse({ description: BAD_ID })
  @ApiNotFoundResponse({ description: NOT_FOUND_CHOFER })
  @ApiConflictResponse({ description: START_CONFLICT })
  iniciar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StartRouteSheetDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<StartRouteSheetResponseDto> {
    return this.start.iniciar(
      distributorId,
      id,
      { userId, esChofer: true },
      body.acknowledgeShortages === true,
    );
  }

  @Post(':id/stops/:orderId/on-the-way')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'Salir hacia una parada («En camino»)',
    description:
      'El pedido pasa a en camino (empieza el seguimiento del cliente). Una sola parada en camino a la vez. Si no es la siguiente propuesta, es un desvío: la cola se reordena desde ahí (`detour: true`). Repetirla sobre la misma parada responde 200 sin cambios.',
  })
  @ApiOkResponse({ type: RouteSheetStopActionResponseDto })
  @ApiBadRequestResponse({ description: BAD_ID })
  @ApiNotFoundResponse({ description: NOT_FOUND_CHOFER })
  @ApiConflictResponse({ description: STOP_CONFLICT })
  enCamino(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetStopActionResponseDto> {
    return this.stops.enCamino(distributorId, id, orderId, userId);
  }

  @Post(':id/stops/:orderId/arrived')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: '«Llegué» a la parada',
    description:
      'El mismo aviso que `PATCH /v2/orders/:id/arrived` (con el radio de llegada de la distribuidora); además queda anotado en la parada (`arrivedAt`, la primera vez) y el panel lo ve.',
  })
  @ApiOkResponse({ type: RouteSheetArrivedResponseDto })
  @ApiBadRequestResponse({
    description: 'Latitud o longitud faltante o fuera de rango; id inválido',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_CHOFER })
  @ApiConflictResponse({
    description:
      'ROUTE_SHEET_NOT_IN_PROGRESS; ORDER_NOT_ON_THE_WAY (marcá «En camino» primero); ARRIVAL_TOO_FAR (fuera del radio: trae `distanceMeters` y `radiusMeters`)',
  })
  llegue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: ArrivedDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetArrivedResponseDto> {
    return this.stops.llegue(distributorId, id, orderId, userId, body);
  }

  @Post(':id/stops/:orderId/failed')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'orderId', format: 'uuid' })
  @ApiOperation({
    summary: 'No pude entregar',
    description:
      'Todos los pedidos se entregan: ninguno vuelve al despacho común. Primer intento (`attempt: 1`, `outcome: requeued`): el pedido sigue siendo del chofer y la parada pasa al FINAL de la cola, que se reacomoda para seguir con la siguiente. Segundo intento (la parada ya era un reintento: `attempt: 2`, `outcome: rescheduled`): sale de la hoja y el sistema reprograma solo el pedido para el día hábil siguiente con su franja (`rescheduledTo`); el admin puede cambiarle la fecha o cancelarlo después, pero no tiene que hacer nada. En los dos casos se le avisa al cliente por push y al admin (panel y bandeja, informativo). Se sugiere al chofer marcarlo cuando vence la espera en la puerta (`route-sheet:wait-expired`, `arrivalWaitMinutes` desde «Llegué»).',
  })
  @ApiOkResponse({ type: RouteSheetStopActionResponseDto })
  @ApiBadRequestResponse({
    description: `${BAD_ID}: \`reason\` fuera de la lista, o \`reason: other\` sin \`note\``,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_CHOFER })
  @ApiConflictResponse({ description: STOP_CONFLICT })
  noEntregada(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() body: FailedStopDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RouteSheetStopActionResponseDto> {
    return this.stops.noEntregada(
      distributorId,
      id,
      orderId,
      { userId, esChofer: true },
      body,
    );
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Cerrar mi hoja con paradas pendientes',
    description:
      'Las paradas que faltan salen de la hoja (`sheet_closed`, con el motivo) y sus pedidos se reprograman solos para el día hábil siguiente (no vuelven al despacho común; al cliente le llega el push). Cuando todo se entregó la hoja se cierra sola. Idempotente: una hoja ya cerrada responde `alreadyClosed: true`.',
  })
  @ApiOkResponse({ type: CloseRouteSheetResponseDto })
  @ApiBadRequestResponse({
    description: `${BAD_ID}: \`reason\` de 5 a 280 caracteres`,
  })
  @ApiNotFoundResponse({ description: NOT_FOUND_CHOFER })
  @ApiConflictResponse({
    description:
      'ROUTE_SHEET_NOT_IN_PROGRESS (todavía no se inició), ROUTE_SHEET_BUSY',
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
      { userId, esChofer: true },
      body.reason,
    );
  }
}
