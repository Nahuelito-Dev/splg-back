import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import { AssistantFaqResponseDto } from '../assistant/dto/assistant-faq.dto';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { RequiereModulo } from '../platform/access/requiere-modulo.decorator';
import {
  MINUTOS_ENTRE_CORRIDAS,
  SEGUNDOS_SIN_LATIDO,
  TOPE_DE_CASOS,
} from './assistant-lab.dominio';
import { AssistantLabMapper } from './assistant-lab.mapper';
import {
  AssistantPreviewDto,
  AssistantPreviewResponseDto,
  CreateFaqFromUnansweredDto,
  CreateRegressionCaseDto,
  QueryUnansweredDto,
  RegressionCaseListResponseDto,
  RegressionCaseResponseDto,
  RegressionRunResponseDto,
  UnansweredListResponseDto,
  UpdateRegressionCaseDto,
} from './dto/assistant-lab.dto';
import { PreguntasSinRespuestaService } from './preguntas-sin-respuesta.service';
import { ProbadorService } from './probador.service';
import { RegresionService } from './regresion.service';

const FALTA_DISTRIBUIDORA =
  'falta la distribuidora: super admin sin sesión de soporte ni empresa propia (`MISSING_DISTRIBUTOR`)';

const ID_INVALIDO = 'El id no es válido (`INVALID_ID`)';

const PERIODO_INVALIDO =
  'Fecha que no es AAAA-MM-DD o no existe, «desde» posterior a «hasta», período de más de 366 días o parámetro desconocido';

const GRUPO_INEXISTENTE =
  'No hay preguntas pendientes con ese id en el último año: ya se resolvió o descartó, o es de otra distribuidora (`ASSISTANT_UNANSWERED_NOT_FOUND`)';

const CASO_INEXISTENTE =
  'No existe, ya está dado de baja o es de otra distribuidora (`ASSISTANT_REGRESSION_CASE_NOT_FOUND`)';

const CASO_REPETIDO =
  'Ya hay un caso con esa misma pregunta (`ASSISTANT_REGRESSION_CASE_DUPLICATE`)';

const DATOS_DEL_CASO_INVALIDOS = `Datos inválidos (p. ej. «Pregunta: tiene que tener entre 2 y 500 caracteres», «expected» que no es \`answer\` ni \`handoff\`, más de 10 menciones, menciones con \`handoff\`, un campo que no corresponde) o ${FALTA_DISTRIBUIDORA}`;

const SOLO_ASISTENTE =
  'Además: sin el permiso que pide (`PERMISSION_DENIED`) o la distribuidora no tiene el asistente del chat (`MODULE_DISABLED`)';

/**
 * Probador, preguntas sin respuesta y lote de regresión del asistente de la
 * distribuidora (Configuración → Asistente del chat, DISENO-CH-BOT §7). Todo
 * de la distribuidora del contexto: ningún endpoint recibe su id y lo de otra
 * responde 404. Módulo M8. En modo soporte sólo se lee (403
 * `SUPPORT_READ_ONLY` al probar o escribir).
 */
@ApiTags('Configuración · Asistente del chat')
@RequiereModulo('assistant')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'company/assistant', version: '2' })
export class CompanyAssistantLabController {
  constructor(
    private readonly probador: ProbadorService,
    private readonly sinRespuesta: PreguntasSinRespuestaService,
    private readonly regresion: RegresionService,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Permiso('asistente.gestionar')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Probar una pregunta',
    description: `Contesta como lo haría el asistente en una conversación real con un cliente, por el mismo camino (base de conocimiento sin borradores, herramientas de sólo lectura, derivación y topes), sin crear conversación ni mensaje, sin avisar a nadie y sin contar en las métricas. Con \`customerId\`, «estado de mi pedido» lee los pedidos de ese cliente. Un solo tope mensual para la empresa: suma sus conversaciones y sus pruebas (probador y lote) y nunca se pasa del 100 % (si se llegó, deriva igual que una conversación, \`monthly_limit\`). Además, las pruebas no pueden pasar el 10 % de ese tope, contado sólo sobre ellas (429 \`ASSISTANT_TEST_QUOTA_REACHED\`). Corre aunque el asistente esté apagado (\`assistantEnabled\` dice si hoy contestaría). Hasta 20 por minuto por sesión. ${SOLO_ASISTENTE}.`,
  })
  @ApiOkResponse({ type: AssistantPreviewResponseDto })
  @ApiBadRequestResponse({
    description: `Pregunta vacía o de más de 2000 caracteres, \`customerId\` que no es uuid, un campo que no corresponde, o ${FALTA_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({
    description:
      'El cliente no existe o no es de la distribuidora (`ASSISTANT_PREVIEW_CUSTOMER_NOT_FOUND`)',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Más de 20 pruebas por minuto en la sesión, o se terminó el cupo de pruebas del mes (`ASSISTANT_TEST_QUOTA_REACHED`)',
  })
  probar(
    @Body() dto: AssistantPreviewDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<AssistantPreviewResponseDto> {
    return this.probador.deLaEmpresa({
      distributorId,
      question: dto.question,
      customerId: dto.customerId,
      actorUserId,
    });
  }

  @Get('unanswered')
  @Auth(RoleType.ADMIN)
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Preguntas sin respuesta',
    description: `Lo que el asistente no supo contestar a los clientes de la distribuidora en conversaciones reales, agrupado por texto parecido (sin tildes, mayúsculas, saludos ni palabras vacías, y en cualquier orden), con cuántas veces y cuándo. Cuenta cuando pasó a una persona con la IA corriendo porque no tenía la información o no estaba segura (\`pasar_a_persona\` con causa \`no_info\` o \`low_confidence\`) o porque no llegó a una respuesta que sirva (\`refusal\`, \`max_tokens\`, \`no_text\`, \`invalid_text\`, \`tool_rounds\`, \`unverified_amount\`). No cuentan que la persona pida hablar con alguien, los reclamos ni las derivaciones sin IA (tope, falla). Sólo de sus clientes; sin los mensajes retirados o anonimizados. Un grupo resuelto o descartado vuelve si se pregunta de nuevo. Sin fechas, los últimos 30 días. Lleva texto de los clientes: sólo el personal de la empresa, nunca el administrador general (ni en modo soporte). ${SOLO_ASISTENTE}.`,
  })
  @ApiOkResponse({ type: UnansweredListResponseDto })
  @ApiBadRequestResponse({
    description: `${PERIODO_INVALIDO}, o ${FALTA_DISTRIBUIDORA}`,
  })
  async sinResponder(
    @Query() query: QueryUnansweredDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<UnansweredListResponseDto> {
    return AssistantLabMapper.toUnansweredDto(
      await this.sinRespuesta.listar(distributorId, query.from, query.to),
    );
  }

  @Post('unanswered/:id/faq')
  @Permiso('asistente.gestionar')
  @ApiParam({ name: 'id', description: 'Id del grupo (32 hexadecimales)' })
  @ApiOperation({
    summary: 'Crear una pregunta frecuente desde una pregunta sin respuesta',
    description: `Crea en la base de la distribuidora una pregunta frecuente en borrador (\`isDraft\`, sin respuesta: el asistente no la usa hasta que se le cargue con \`PATCH /company/assistant/faqs/:id\`) con la pregunta que confirmó o editó la persona (obligatoria: el back no copia solo el texto del cliente), y marca el grupo como resuelto, todo junto (201). Si el grupo volvió a aparecer y ya tenía su pregunta creada y vigente, devuelve esa (200) y lo vuelve a marcar resuelto, sin crear otra. Máximo ${TOPE_DE_PREGUNTAS} preguntas. ${SOLO_ASISTENTE}.`,
  })
  @ApiCreatedResponse({
    type: AssistantFaqResponseDto,
    description: 'Pregunta en borrador creada',
  })
  @ApiOkResponse({
    type: AssistantFaqResponseDto,
    description: 'El grupo ya tenía su pregunta creada y vigente: es esa',
  })
  @ApiBadRequestResponse({
    description: `${ID_INVALIDO}; falta la pregunta, tiene menos de 5 o más de 200 caracteres o lleva HTML; o ${FALTA_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({ description: GRUPO_INEXISTENTE })
  @ApiConflictResponse({
    description: `Ya hay una pregunta igual en la base (\`ASSISTANT_FAQ_DUPLICATE\`) o la base ya tiene ${TOPE_DE_PREGUNTAS} preguntas (\`ASSISTANT_FAQ_LIMIT_REACHED\`)`,
  })
  async crearPregunta(
    @Param('id') id: string,
    @Body() dto: CreateFaqFromUnansweredDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssistantFaqResponseDto> {
    const { faq, creada } = await this.sinRespuesta.crearPregunta(
      distributorId,
      id,
      dto.question,
      actorUserId,
    );
    res.status(creada ? HttpStatus.CREATED : HttpStatus.OK);
    return AssistantFaqMapper.toDto(faq);
  }

  @Post('unanswered/:id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('asistente.gestionar')
  @ApiParam({ name: 'id', description: 'Id del grupo (32 hexadecimales)' })
  @ApiOperation({
    summary: 'Descartar una pregunta sin respuesta',
    description: `Deja de mostrar lo que hay hasta ahora en el grupo; si se vuelve a preguntar, aparece de nuevo. ${SOLO_ASISTENTE}.`,
  })
  @ApiNoContentResponse({ description: 'Descartado' })
  @ApiBadRequestResponse({
    description: `${ID_INVALIDO}, o ${FALTA_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({ description: GRUPO_INEXISTENTE })
  async descartar(
    @Param('id') id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<void> {
    await this.sinRespuesta.descartar(distributorId, id, actorUserId);
  }

  @Get('regression/cases')
  @Permiso('asistente.ver')
  @ApiOperation({
    summary: 'Casos del lote de regresión',
    description: `Los vigentes, en el orden en que se cargaron, con el tope (${TOPE_DE_CASOS}). ${SOLO_ASISTENTE}.`,
  })
  @ApiOkResponse({ type: RegressionCaseListResponseDto })
  @ApiBadRequestResponse({
    description: `Falta la distribuidora (\`MISSING_DISTRIBUTOR\`)`,
  })
  async listarCasos(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RegressionCaseListResponseDto> {
    return AssistantLabMapper.toCaseListDto(
      await this.regresion.listar(distributorId),
    );
  }

  @Post('regression/cases')
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Nuevo caso del lote de regresión',
    description: `Una pregunta y lo que se espera: que responda (y qué tiene que mencionar) o que pase a una persona. Máximo ${TOPE_DE_CASOS}. Queda en la auditoría. ${SOLO_ASISTENTE}.`,
  })
  @ApiCreatedResponse({ type: RegressionCaseResponseDto })
  @ApiBadRequestResponse({ description: DATOS_DEL_CASO_INVALIDOS })
  @ApiConflictResponse({
    description: `${CASO_REPETIDO}, o ya hay ${TOPE_DE_CASOS} casos (\`ASSISTANT_REGRESSION_CASE_LIMIT_REACHED\`)`,
  })
  async crearCaso(
    @Body() dto: CreateRegressionCaseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<RegressionCaseResponseDto> {
    return AssistantLabMapper.toCaseDto(
      await this.regresion.crear(distributorId, dto, actorUserId),
    );
  }

  @Patch('regression/cases/:id')
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Editar un caso del lote de regresión',
    description: `Lo que no viene queda como estaba; pasar a \`handoff\` sin mandar menciones las vacía. ${SOLO_ASISTENTE}.`,
  })
  @ApiOkResponse({ type: RegressionCaseResponseDto })
  @ApiBadRequestResponse({
    description: `El id no es un UUID (\`INVALID_ID\`). ${DATOS_DEL_CASO_INVALIDOS}`,
  })
  @ApiNotFoundResponse({ description: CASO_INEXISTENTE })
  @ApiConflictResponse({ description: CASO_REPETIDO })
  async actualizarCaso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRegressionCaseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<RegressionCaseResponseDto> {
    return AssistantLabMapper.toCaseDto(
      await this.regresion.actualizar(distributorId, id, dto, actorUserId),
    );
  }

  @Delete('regression/cases/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Dar de baja un caso del lote de regresión',
    description: `Baja lógica: deja de correrse y la pregunta queda libre. Las corridas anteriores lo conservan. ${SOLO_ASISTENTE}.`,
  })
  @ApiNoContentResponse({ description: 'Dado de baja' })
  @ApiBadRequestResponse({
    description: `El id no es un UUID (\`INVALID_ID\`), o ${FALTA_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({ description: CASO_INEXISTENTE })
  async darDeBajaCaso(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<void> {
    await this.regresion.darDeBaja(distributorId, id, actorUserId);
  }

  @Post('regression/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Correr el lote de regresión',
    description: `Corre todos los casos vigentes con el probador (mismo camino que una conversación real) y responde enseguida con la corrida \`running\`, sin esperarla: los casos se corren de a uno y cada resultado se guarda al terminarlo (\`GET /company/assistant/regression/runs/last\` muestra el avance). Cada caso gasta como una prueba: suma al tope mensual único de la empresa y al sub-tope de pruebas (el 10 % del mensual); pasado el sub-tope, ese caso y los que siguen quedan \`error\` (\`test_quota_reached\`), y pasado el tope único quedan \`error\` (\`assistant_not_run\`, la IA no corre), y un caso que falla queda \`error\` (\`case_error\`) sin cortar la corrida. Una corrida en curso por distribuidora y una cada ${MINUTOS_ENTRE_CORRIDAS} minutos; cada caso terminado deja un latido y una corrida sin latido por ${SEGUNDOS_SIN_LATIDO} s se da por perdida. ${SOLO_ASISTENTE}.`,
  })
  @ApiAcceptedResponse({ type: RegressionRunResponseDto })
  @ApiBadRequestResponse({
    description: `Falta la distribuidora (\`MISSING_DISTRIBUTOR\`)`,
  })
  @ApiConflictResponse({
    description:
      'Ya hay una corrida en curso (`ASSISTANT_REGRESSION_RUN_IN_PROGRESS`) o no hay casos vigentes (`ASSISTANT_REGRESSION_NO_CASES`)',
  })
  @ApiTooManyRequestsResponse({
    description: `La última corrida empezó hace menos de ${MINUTOS_ENTRE_CORRIDAS} minutos (\`ASSISTANT_REGRESSION_RUN_COOLDOWN\`)`,
  })
  async correr(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<RegressionRunResponseDto> {
    return AssistantLabMapper.toRunDto(
      await this.regresion.iniciar(distributorId, actorUserId),
    );
  }

  @Get('regression/runs/last')
  @Permiso('asistente.ver')
  @ApiOperation({
    summary: 'Última corrida del lote de regresión',
    description: `La más reciente (en curso o terminada), con el resultado de cada caso y por qué pasó o no, y el resumen. Una «en curso» sin latido hace más de ${SEGUNDOS_SIN_LATIDO} s sale \`failed\` (con \`finishedAt\` en su último latido). ${SOLO_ASISTENTE}.`,
  })
  @ApiOkResponse({ type: RegressionRunResponseDto })
  @ApiBadRequestResponse({
    description: `Falta la distribuidora (\`MISSING_DISTRIBUTOR\`)`,
  })
  @ApiNotFoundResponse({
    description:
      'Todavía no se corrió nunca (`ASSISTANT_REGRESSION_RUN_NOT_FOUND`)',
  })
  async ultimaCorrida(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RegressionRunResponseDto> {
    return AssistantLabMapper.toRunDto(
      await this.regresion.ultima(distributorId),
    );
  }
}
