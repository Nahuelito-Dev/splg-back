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
import { AssistantFaqTemplateService } from './assistant-faq-template.service';
import { AssistantFaqMapper } from './assistant-faq.mapper';
import { TOPE_DE_PREGUNTAS } from './assistant.errors';
import {
  CreateAssistantFaqTemplateDto,
  PlatformAssistantFaqTemplateListResponseDto,
  PlatformAssistantFaqTemplateResponseDto,
  UpdateAssistantFaqTemplateDto,
} from './dto/assistant-faq.dto';

const DATOS_INVALIDOS =
  'Datos inválidos (p. ej. «Pregunta: tiene que tener entre 5 y 200 caracteres», «Respuesta: no puede llevar HTML…», «Clave: no tiene un formato válido», un campo que no corresponde)';

const ID_INVALIDO = 'El id no es un UUID (`INVALID_ID`)';

const NO_EXISTE =
  'No existe o ya está dada de baja (`ASSISTANT_TEMPLATE_NOT_FOUND`)';

const REPETIDA =
  'Ya hay una pregunta de ejemplo igual en el catálogo (`ASSISTANT_TEMPLATE_DUPLICATE`)';

/**
 * Catálogo de preguntas de ejemplo para distribuidoras (DISENO-CH-BOT D-B7):
 * OrixTech lo carga acá y cada distribuidora lo copia a su base
 * (`POST /company/assistant/faqs/from-templates`); desde la copia, la
 * pregunta es de ella. No es la base del soporte de OrixTech
 * (`/platform/assistant/faqs`, D-B6). Sólo administrador general, alcance
 * `plataforma`.
 */
@ApiTags('Asistente del chat (plataforma)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/assistant/templates', version: '2' })
export class PlatformAssistantTemplateController {
  constructor(private readonly ejemplos: AssistantFaqTemplateService) {}

  @Get()
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Preguntas de ejemplo para distribuidoras',
    description:
      'Las vigentes del catálogo, en su orden (el mismo con el que se copian), y el tope.',
  })
  @ApiOkResponse({ type: PlatformAssistantFaqTemplateListResponseDto })
  async listar(): Promise<PlatformAssistantFaqTemplateListResponseDto> {
    return AssistantFaqMapper.toPlatformTemplateListDto(
      await this.ejemplos.listar(),
    );
  }

  @Post()
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Nueva pregunta de ejemplo',
    description: `Texto plano, con su clave; va al final del catálogo. Las distribuidoras la ven y la copian cuando cargan las preguntas de ejemplo; lo ya copiado no cambia. Máximo ${TOPE_DE_PREGUNTAS}.`,
  })
  @ApiCreatedResponse({ type: PlatformAssistantFaqTemplateResponseDto })
  @ApiBadRequestResponse({ description: DATOS_INVALIDOS })
  @ApiConflictResponse({
    description: `${REPETIDA}, ya hay una con esa clave (\`ASSISTANT_TEMPLATE_KEY_TAKEN\`) o el catálogo ya tiene ${TOPE_DE_PREGUNTAS} (\`ASSISTANT_TEMPLATE_LIMIT_REACHED\`)`,
  })
  async crear(
    @Body() dto: CreateAssistantFaqTemplateDto,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PlatformAssistantFaqTemplateResponseDto> {
    return AssistantFaqMapper.toPlatformTemplateDto(
      await this.ejemplos.crear(dto, actorUserId),
    );
  }

  @Patch(':id')
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Editar una pregunta de ejemplo',
    description:
      'Lo que no viene queda como estaba; la clave no cambia. Lo ya copiado a las distribuidoras no se toca: cada una ajusta la suya.',
  })
  @ApiOkResponse({ type: PlatformAssistantFaqTemplateResponseDto })
  @ApiBadRequestResponse({ description: `${ID_INVALIDO}. ${DATOS_INVALIDOS}` })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({ description: REPETIDA })
  async actualizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssistantFaqTemplateDto,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<PlatformAssistantFaqTemplateResponseDto> {
    return AssistantFaqMapper.toPlatformTemplateDto(
      await this.ejemplos.actualizar(id, dto, actorUserId),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Dar de baja una pregunta de ejemplo',
    description:
      'Baja lógica: deja de ofrecerse; su clave y su pregunta quedan libres. Lo ya copiado a las distribuidoras sigue.',
  })
  @ApiNoContentResponse({ description: 'Dada de baja' })
  @ApiBadRequestResponse({ description: ID_INVALIDO })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async darDeBaja(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<void> {
    await this.ejemplos.darDeBaja(id, actorUserId);
  }
}
