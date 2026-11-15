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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SinDistribuidora } from '../common/decorators/sin-distribuidora.decorator';
import { PermisoDePlataforma } from '../common/permisos/catalogo-de-plataforma';
import { AssistantFaqMapper } from './assistant-faq.mapper';
import { AssistantFaqService } from './assistant-faq.service';
import { TOPE_DE_PREGUNTAS } from './assistant.errors';
import {
  CreatePlatformAssistantFaqDto,
  PlatformAssistantFaqListResponseDto,
  PlatformAssistantFaqResponseDto,
  UpdatePlatformAssistantFaqDto,
} from './dto/assistant-faq.dto';

const DATOS_INVALIDOS =
  'Datos inválidos (p. ej. «Pregunta: tiene que tener entre 5 y 200 caracteres», «Respuesta: no puede llevar HTML…», «Clave: no tiene un formato válido», un campo que no corresponde)';

const ID_INVALIDO = 'El id no es un UUID (`INVALID_ID`)';

const NO_EXISTE =
  'No existe, ya está dada de baja o no es de la base de la plataforma (`ASSISTANT_FAQ_NOT_FOUND`)';

const REPETIDA =
  'Ya hay una pregunta igual en la base (`ASSISTANT_FAQ_DUPLICATE`)';

/**
 * Base de conocimiento del asistente de la plataforma (DISENO-CH-BOT §4.3):
 * la del soporte de OrixTech (C1) y, las marcadas `useAsTemplate`, las
 * plantillas que copia cada distribuidora (§9 D-B4). Sólo administrador
 * general, alcance `plataforma` (no depende del módulo de ninguna empresa).
 */
@ApiTags('Asistente del chat (plataforma)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/assistant/faqs', version: '2' })
export class PlatformAssistantFaqController {
  constructor(private readonly preguntas: AssistantFaqService) {}

  @Get()
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Preguntas frecuentes de la plataforma',
    description:
      'Las vigentes, con su clave y si se ofrecen como plantilla, la versión de la base y el tope de preguntas.',
  })
  @ApiOkResponse({ type: PlatformAssistantFaqListResponseDto })
  async listar(): Promise<PlatformAssistantFaqListResponseDto> {
    return AssistantFaqMapper.toPlatformListDto(
      await this.preguntas.listar(null),
    );
  }

  @Post()
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Nueva pregunta frecuente de la plataforma',
    description: `Texto plano, con su clave. Por omisión se ofrece como plantilla a las distribuidoras. Sube la versión de la base. Máximo ${TOPE_DE_PREGUNTAS}.`,
  })
  @ApiCreatedResponse({ type: PlatformAssistantFaqResponseDto })
  @ApiBadRequestResponse({ description: DATOS_INVALIDOS })
  @ApiConflictResponse({
    description: `${REPETIDA}, ya hay una con esa clave (\`ASSISTANT_FAQ_KEY_TAKEN\`) o la base ya tiene ${TOPE_DE_PREGUNTAS} preguntas (\`ASSISTANT_FAQ_LIMIT_REACHED\`)`,
  })
  async crear(
    @Body() dto: CreatePlatformAssistantFaqDto,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PlatformAssistantFaqResponseDto> {
    return AssistantFaqMapper.toPlatformDto(
      await this.preguntas.crear(null, dto, actorUserId),
    );
  }

  @Patch(':id')
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Editar una pregunta frecuente de la plataforma',
    description:
      'Lo que no viene queda como estaba; la clave no cambia. Lo ya copiado a las distribuidoras no se toca: cada una ajusta la suya. Si cambia algo, sube la versión de la base.',
  })
  @ApiOkResponse({ type: PlatformAssistantFaqResponseDto })
  @ApiBadRequestResponse({ description: `${ID_INVALIDO}. ${DATOS_INVALIDOS}` })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({ description: REPETIDA })
  async actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformAssistantFaqDto,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PlatformAssistantFaqResponseDto> {
    return AssistantFaqMapper.toPlatformDto(
      await this.preguntas.actualizar(null, id, dto, actorUserId),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Dar de baja una pregunta frecuente de la plataforma',
    description:
      'Baja lógica: deja de usarse y de ofrecerse como plantilla; su clave queda libre. Lo ya copiado a las distribuidoras sigue. Sube la versión de la base.',
  })
  @ApiNoContentResponse({ description: 'Dada de baja' })
  @ApiBadRequestResponse({ description: ID_INVALIDO })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async darDeBaja(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<void> {
    await this.preguntas.darDeBaja(null, id, actorUserId);
  }
}
