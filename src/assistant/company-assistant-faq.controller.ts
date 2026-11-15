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
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { RequiereModulo } from '../platform/access/requiere-modulo.decorator';
import { AssistantFaqMapper } from './assistant-faq.mapper';
import { AssistantFaqService } from './assistant-faq.service';
import { TOPE_DE_PREGUNTAS } from './assistant.errors';
import {
  AssistantFaqListResponseDto,
  AssistantFaqResponseDto,
  CopyAssistantTemplatesResponseDto,
  CreateAssistantFaqDto,
  UpdateAssistantFaqDto,
} from './dto/assistant-faq.dto';

const FALTA_DISTRIBUIDORA =
  'Falta la distribuidora: super admin sin sesión de soporte ni empresa propia (`MISSING_DISTRIBUTOR`)';

const O_FALTA_DISTRIBUIDORA = `o ${FALTA_DISTRIBUIDORA.charAt(0).toLowerCase()}${FALTA_DISTRIBUIDORA.slice(1)}`;

const DATOS_INVALIDOS = `Datos inválidos (p. ej. «Pregunta: tiene que tener entre 5 y 200 caracteres», «Respuesta: no puede llevar HTML…», un campo que no corresponde) ${O_FALTA_DISTRIBUIDORA}`;

const ID_INVALIDO = 'El id no es un UUID (`INVALID_ID`)';

const NO_EXISTE =
  'No existe, ya está dada de baja o es de otra distribuidora (`ASSISTANT_FAQ_NOT_FOUND`)';

const REPETIDA =
  'Ya hay una pregunta igual en la base (`ASSISTANT_FAQ_DUPLICATE`)';

const TOPE = `La base ya tiene ${TOPE_DE_PREGUNTAS} preguntas, el máximo (\`ASSISTANT_FAQ_LIMIT_REACHED\`)`;

/**
 * Base de conocimiento del asistente del chat de la distribuidora
 * (DISENO-CH-BOT §4.3, Configuración → Asistente del chat). Siempre la del
 * contexto: el admin, la suya; el super admin, la de su sesión de soporte
 * (sólo lectura) o la de su empresa propia. Ningún endpoint recibe el id de
 * una distribuidora: lo de otra responde 404. Módulo M8, apagado por omisión.
 */
@ApiTags('Configuración · Asistente del chat')
@RequiereModulo('assistant')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'company/assistant/faqs', version: '2' })
export class CompanyAssistantFaqController {
  constructor(private readonly preguntas: AssistantFaqService) {}

  @Get()
  @Permiso('asistente.ver')
  @ApiOperation({
    summary: 'Preguntas frecuentes del asistente',
    description:
      'Las vigentes, en el orden en que se cargaron, con la versión de la base (la usa el asistente para saber si su contexto sigue vigente) y el tope de preguntas.',
  })
  @ApiOkResponse({ type: AssistantFaqListResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async listar(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<AssistantFaqListResponseDto> {
    return AssistantFaqMapper.toListDto(
      await this.preguntas.listar(distributorId),
    );
  }

  @Post()
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Nueva pregunta frecuente',
    description: `Texto plano. Sube la versión de la base. Queda en la auditoría. Máximo ${TOPE_DE_PREGUNTAS} por distribuidora. En modo soporte, 403 \`SUPPORT_READ_ONLY\`.`,
  })
  @ApiCreatedResponse({ type: AssistantFaqResponseDto })
  @ApiBadRequestResponse({ description: DATOS_INVALIDOS })
  @ApiConflictResponse({ description: `${REPETIDA}, o ${TOPE}` })
  async crear(
    @Body() dto: CreateAssistantFaqDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<AssistantFaqResponseDto> {
    return AssistantFaqMapper.toDto(
      await this.preguntas.crear(distributorId, dto, actorUserId),
    );
  }

  @Post('from-templates')
  @HttpCode(HttpStatus.OK)
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Copiar las plantillas de OrixTech',
    description:
      'Copia a la base las plantillas vigentes de la plataforma que todavía no tiene (por su clave o porque ya hay una pregunta igual), para ajustarlas después. Idempotente: repetirlo no duplica nada ni sube la versión. Todo o nada: si no entran todas bajo el tope, no copia ninguna (409). En modo soporte, 403 `SUPPORT_READ_ONLY`.',
  })
  @ApiOkResponse({ type: CopyAssistantTemplatesResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({
    description: `Copiarlas superaría el máximo de ${TOPE_DE_PREGUNTAS} preguntas (\`ASSISTANT_FAQ_LIMIT_REACHED\`)`,
  })
  copiarPlantillas(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<CopyAssistantTemplatesResponseDto> {
    return this.preguntas.copiarPlantillas(distributorId, actorUserId);
  }

  @Patch(':id')
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Editar una pregunta frecuente',
    description:
      'Lo que no viene queda como estaba. Si cambia algo, sube la versión de la base. En modo soporte, 403 `SUPPORT_READ_ONLY`.',
  })
  @ApiOkResponse({ type: AssistantFaqResponseDto })
  @ApiBadRequestResponse({ description: `${ID_INVALIDO}. ${DATOS_INVALIDOS}` })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({ description: REPETIDA })
  async actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssistantFaqDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<AssistantFaqResponseDto> {
    return AssistantFaqMapper.toDto(
      await this.preguntas.actualizar(distributorId, id, dto, actorUserId),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('asistente.gestionar')
  @ApiOperation({
    summary: 'Dar de baja una pregunta frecuente',
    description:
      'Baja lógica: el asistente deja de usarla y la pregunta queda libre para cargarla de nuevo. Sube la versión de la base. En modo soporte, 403 `SUPPORT_READ_ONLY`.',
  })
  @ApiNoContentResponse({ description: 'Dada de baja' })
  @ApiBadRequestResponse({
    description: `${ID_INVALIDO}, ${O_FALTA_DISTRIBUIDORA}`,
  })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async darDeBaja(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<void> {
    await this.preguntas.darDeBaja(distributorId, id, actorUserId);
  }
}
