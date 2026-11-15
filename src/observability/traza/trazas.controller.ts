import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { TraceResponseDto } from './dto/trace-response.dto';
import { ParseTraceIdPipe } from './parse-trace-id.pipe';
import { TrazasService } from './trazas.service';

/**
 * Trazas de punta a punta (API v2, DISENO-OBSERVABILIDAD §7.5). Es de la
 * PLATAFORMA: sólo el administrador general, también en una sesión de
 * soporte; el admin de una empresa recibe 403.
 */
@ApiTags('Plataforma · Monitoreo')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/traces', version: '2' })
export class TrazasController {
  constructor(private readonly service: TrazasService) {}

  @Get(':traceId')
  @ApiOperation({
    summary: 'Línea de tiempo de una traza',
    description:
      'Todo lo que quedó con ese `traceId` (el `X-Request-Id` que devuelve cada respuesta, el de un webhook o el `traceId` de una corrida): asientos de auditoría de las escrituras, corridas de procesos automáticos y avisos de la bandeja, lo más viejo primero. Sin datos personales ni el detalle de los cambios. Sólo el administrador general.',
  })
  @ApiOkResponse({ type: TraceResponseDto })
  @ApiBadRequestResponse({
    description:
      '`traceId` de más de 64 caracteres o con caracteres fuera de letras, números, `-` y `_` (`INVALID_TRACE_ID`)',
  })
  @ApiNotFoundResponse({
    description:
      'No hay nada registrado con esa traza o ya se depuró (`TRACE_NOT_FOUND`)',
  })
  traza(
    @Param('traceId', ParseTraceIdPipe) traceId: string,
  ): Promise<TraceResponseDto> {
    return this.service.traza(traceId);
  }
}
