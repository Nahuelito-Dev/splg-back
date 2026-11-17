import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AssistantFaqMapper } from '../assistant/assistant-faq.mapper';
import { TOPE_DE_PREGUNTAS } from '../assistant/assistant.errors';
import { PlatformAssistantFaqResponseDto } from '../assistant/dto/assistant-faq.dto';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SinDistribuidora } from '../common/decorators/sin-distribuidora.decorator';
import { PermisoDePlataforma } from '../common/permisos/catalogo-de-plataforma';
import { AssistantLabMapper } from './assistant-lab.mapper';
import {
  AssistantPreviewResponseDto,
  CreateFaqFromUnansweredDto,
  PlatformAssistantPreviewDto,
  QueryUnansweredDto,
  UnansweredListResponseDto,
} from './dto/assistant-lab.dto';
import { PreguntasSinRespuestaService } from './preguntas-sin-respuesta.service';
import { ProbadorService } from './probador.service';

const GRUPO_INEXISTENTE =
  'No hay preguntas pendientes con ese id en el último año: ya se resolvió o descartó, o no es del soporte de la plataforma (`ASSISTANT_UNANSWERED_NOT_FOUND`)';

const ID_INVALIDO = 'El id no es válido (`INVALID_ID`)';

/**
 * Probador y preguntas sin respuesta del asistente del soporte de la
 * plataforma (C1, la base de OrixTech): sólo lo suyo, nunca lo de las
 * empresas con sus clientes (D-B6). Sólo administrador general, alcance
 * `plataforma`.
 */
@ApiTags('Asistente del chat (plataforma)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/assistant', version: '2' })
export class PlatformAssistantLabController {
  constructor(
    private readonly probador: ProbadorService,
    private readonly sinRespuesta: PreguntasSinRespuestaService,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Probar una pregunta en el asistente del soporte',
    description:
      'Contesta como el asistente del soporte a una distribuidora (base de la plataforma), por el mismo camino que una conversación real, sin crear nada, sin avisar a nadie y sin contar en las métricas. Un solo tope mensual para el soporte: suma las conversaciones de todas las empresas y las pruebas de la plataforma, y nunca se pasa del 100 % (si se llegó, deriva igual que una conversación). Además, las pruebas de la plataforma no pueden pasar el 10 % de ese tope, contado sólo sobre ellas (429 `ASSISTANT_TEST_QUOTA_REACHED`). Hasta 20 por minuto por sesión.',
  })
  @ApiOkResponse({ type: AssistantPreviewResponseDto })
  @ApiBadRequestResponse({
    description:
      'Pregunta vacía o de más de 2000 caracteres, o un campo que no corresponde (como `customerId`)',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Más de 20 pruebas por minuto en la sesión, o se terminó el cupo de pruebas del mes (`ASSISTANT_TEST_QUOTA_REACHED`)',
  })
  probar(
    @Body() dto: PlatformAssistantPreviewDto,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<AssistantPreviewResponseDto> {
    return this.probador.deLaPlataforma(dto.question, actorUserId);
  }

  @Get('unanswered')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Preguntas sin respuesta del soporte',
    description:
      'Lo que el asistente del soporte no supo contestar a las distribuidoras (C1), agrupado por texto parecido, con cuántas veces y cuándo: pasó a una persona porque no tenía la información o no estaba seguro (causa `no_info` o `low_confidence`) o no llegó a una respuesta que sirva (`refusal`, `max_tokens`, `no_text`, `invalid_text`, `tool_rounds`, `unverified_amount`). No cuentan los pedidos de hablar con alguien, los reclamos ni las derivaciones sin IA. Nunca lo que preguntan los clientes de una distribuidora. Sin fechas, los últimos 30 días.',
  })
  @ApiOkResponse({ type: UnansweredListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fecha que no es AAAA-MM-DD o no existe, «desde» posterior a «hasta», período de más de 366 días o parámetro desconocido',
  })
  async sinResponder(
    @Query() query: QueryUnansweredDto,
  ): Promise<UnansweredListResponseDto> {
    return AssistantLabMapper.toUnansweredDto(
      await this.sinRespuesta.listar(null, query.from, query.to),
    );
  }

  @Post('unanswered/:id/faq')
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiParam({ name: 'id', description: 'Id del grupo (32 hexadecimales)' })
  @ApiOperation({
    summary:
      'Crear una pregunta frecuente del soporte desde una pregunta sin respuesta',
    description: `Crea en la base de la plataforma una pregunta en borrador (sin respuesta, con la clave \`sin_respuesta_…\`: el asistente no la usa hasta cargarle la respuesta con \`PATCH /platform/assistant/faqs/:id\`) con la pregunta que confirmó o editó la persona (obligatoria), y marca el grupo como resuelto, todo junto (201). Si el grupo volvió y ya tenía su pregunta vigente, devuelve esa (200) y lo vuelve a marcar resuelto. Máximo ${TOPE_DE_PREGUNTAS} preguntas.`,
  })
  @ApiCreatedResponse({
    type: PlatformAssistantFaqResponseDto,
    description: 'Pregunta en borrador creada',
  })
  @ApiOkResponse({
    type: PlatformAssistantFaqResponseDto,
    description: 'El grupo ya tenía su pregunta creada y vigente: es esa',
  })
  @ApiBadRequestResponse({
    description: `${ID_INVALIDO}; falta la pregunta, tiene menos de 5 o más de 200 caracteres o lleva HTML`,
  })
  @ApiNotFoundResponse({ description: GRUPO_INEXISTENTE })
  @ApiConflictResponse({
    description: `Ya hay una pregunta igual o con esa clave en la base (\`ASSISTANT_FAQ_DUPLICATE\`, \`ASSISTANT_FAQ_KEY_TAKEN\`) o la base ya tiene ${TOPE_DE_PREGUNTAS} preguntas (\`ASSISTANT_FAQ_LIMIT_REACHED\`)`,
  })
  async crearPregunta(
    @Param('id') id: string,
    @Body() dto: CreateFaqFromUnansweredDto,
    @CurrentUser('user_id') actorUserId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlatformAssistantFaqResponseDto> {
    const { faq, creada } = await this.sinRespuesta.crearPregunta(
      null,
      id,
      dto.question,
      actorUserId,
    );
    res.status(creada ? HttpStatus.CREATED : HttpStatus.OK);
    return AssistantFaqMapper.toPlatformDto(faq);
  }

  @Post('unanswered/:id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiParam({ name: 'id', description: 'Id del grupo (32 hexadecimales)' })
  @ApiOperation({
    summary: 'Descartar una pregunta sin respuesta del soporte',
    description:
      'Deja de mostrar lo que hay hasta ahora en el grupo; si se vuelve a preguntar, aparece de nuevo.',
  })
  @ApiNoContentResponse({ description: 'Descartado' })
  @ApiBadRequestResponse({ description: ID_INVALIDO })
  @ApiNotFoundResponse({ description: GRUPO_INEXISTENTE })
  async descartar(
    @Param('id') id: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<void> {
    await this.sinRespuesta.descartar(null, id, actorUserId);
  }
}
