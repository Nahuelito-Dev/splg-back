import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { DrivingRouteDto, DrivingRouteQueryDto } from './dto/driving-route.dto';
import { RoutesService } from './routes.service';

@ApiTags('routes')
@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get('driving')
  @Auth(RoleType.DELIVERY, RoleType.CUSTOMER)
  @ApiOperation({
    summary: 'Ruta por calles de un pedido activo',
    description:
      'Ruta del chofer hasta la dirección de entrega de UN pedido, para dibujarla en el mapa sin que las apps lleven la clave de Google. Sólo la pide el chofer asignado (pedido `accepted` u `on_the_way`) o el cliente dueño (`on_the_way`); el destino es siempre la dirección del pedido. El origen es la última posición reciente del chofer; `from` es opcional y se acepta sólo si está a menos de `ROUTES_FROM_MAX_DISTANCE_M` (300 m) de ella. El servidor consulta la Routes API de Google con su propia clave (`GOOGLE_DIRECTIONS_API_KEY`) y, si falta o Google falla, OSRM propio (`OSRM_BASE_URL`; el público sólo en desarrollo); `provider` dice cuál respondió. Cupos: 30 por minuto y usuario, y por día (24 h) 100 por usuario y 3000 por distribuidora, ajustables con `ROUTES_DAILY_LIMIT_PER_USER` y `ROUTES_DAILY_LIMIT_PER_DISTRIBUTOR` (429). Las respuestas se guardan 60 s por origen y destino redondeados a 4 decimales y no cuentan contra el cupo diario.',
  })
  @ApiOkResponse({ type: DrivingRouteDto })
  @ApiBadRequestResponse({
    description:
      '`orderId` o `from` inválidos, o `from` lejos de la posición del chofer',
  })
  @ApiForbiddenResponse({
    description: 'El pedido no está en un estado activo',
  })
  @ApiNotFoundResponse({ description: 'El pedido no es suyo o no existe' })
  @ApiConflictResponse({
    description: 'Sin posición reciente del chofer o dirección sin coordenadas',
  })
  @ApiResponse({
    status: 429,
    description: 'Superó el cupo por minuto o por día',
  })
  @ApiResponse({
    status: 502,
    description: 'Ningún proveedor de mapas respondió',
  })
  @ApiResponse({
    status: 503,
    description: 'No hay proveedor de rutas configurado',
  })
  driving(
    @Query() query: DrivingRouteQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DrivingRouteDto> {
    return this.routes.driving(query.orderId, query.from, {
      userId: user.user_id,
      role: user.role,
    });
  }
}
