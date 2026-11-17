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
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../../common/constants/role-type.enum';
import { Auth } from '../../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../../common/decorators/current-distributor.decorator';
import { Permiso } from '../../../common/decorators/permiso.decorator';
import { RequiereModulo } from '../../../platform/access/requiere-modulo.decorator';
import { ChatLabelsService } from '../../application/chat-labels.service';
import type { ConversationLabel } from '../../entities/conversation-label.entity';
import {
  CreateChatLabelDto,
  UpdateChatLabelDto,
} from '../dto/bandeja-input.dto';
import {
  ChatLabelListResponseDto,
  ChatLabelResponseDto,
} from '../dto/bandeja-response.dto';

const SIN_PERMISO_DE_LECTURA =
  'La cuenta no es del personal de una empresa, el rol no tiene ninguno de los permisos de mensajes (`PERMISSION_DENIED`) o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)';
const SIN_PERMISO_DE_ESCRITURA =
  'Sin `mensajes.configurar` (`PERMISSION_DENIED`), la cuenta no es del personal o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)';
const NO_EXISTE =
  'No existe, ya está dada de baja o es de otra empresa (`CHAT_LABEL_NOT_FOUND`)';

function etiquetaADto(l: ConversationLabel): ChatLabelResponseDto {
  return {
    id: l.labelId,
    name: l.name,
    color: l.color,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

/**
 * Etiquetas de la bandeja de la empresa (tanda 7c). Leer: cualquiera de los
 * permisos de mensajes; crear, cambiar y dar de baja: `mensajes.configurar`.
 * Siempre de la empresa del perfil: una de otra empresa no existe (404).
 * Módulo `chat`.
 */
@ApiTags('Inbox settings (company)')
@RequiereModulo('chat')
@Permiso(
  'mensajes.clientes',
  'mensajes.choferes',
  'mensajes.configurar',
  'mensajes.supervisar',
)
@Auth(RoleType.ADMIN)
@Controller({ path: 'chat/labels', version: '2' })
export class CompanyChatLabelsController {
  constructor(private readonly etiquetas: ChatLabelsService) {}

  @Get()
  @ApiOperation({
    summary: 'Etiquetas de la bandeja',
    description: 'Las vigentes de la empresa, por nombre.',
  })
  @ApiOkResponse({ type: ChatLabelListResponseDto })
  @ApiForbiddenResponse({ description: SIN_PERMISO_DE_LECTURA })
  async listar(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ChatLabelListResponseDto> {
    return {
      items: (await this.etiquetas.listar(distributorId)).map(etiquetaADto),
    };
  }

  @Post()
  @Permiso('mensajes.configurar')
  @ApiOperation({
    summary: 'Nueva etiqueta',
    description:
      'Nombre de 1 a 30 caracteres y un color de la paleta. Hasta 50 vigentes por empresa. Queda en la auditoría.',
  })
  @ApiCreatedResponse({ type: ChatLabelResponseDto })
  @ApiBadRequestResponse({
    description:
      'Nombre vacío, de más de 30 caracteres o en más de una línea; color fuera de la paleta; campos de más',
  })
  @ApiForbiddenResponse({ description: SIN_PERMISO_DE_ESCRITURA })
  @ApiConflictResponse({
    description:
      'Ya hay una vigente con ese nombre, sin distinguir mayúsculas ni tildes (`CHAT_LABEL_NAME_TAKEN`), o ya hay 50 (`CHAT_LABEL_LIMIT_REACHED`)',
  })
  async crear(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Body() dto: CreateChatLabelDto,
  ): Promise<ChatLabelResponseDto> {
    return etiquetaADto(await this.etiquetas.crear(distributorId, dto));
  }

  @Patch(':id')
  @Permiso('mensajes.configurar')
  @ApiOperation({
    summary: 'Cambiar una etiqueta',
    description:
      'Nombre o color; lo que no viene queda como estaba. Las conversaciones que la tienen la muestran cambiada. Queda en la auditoría.',
  })
  @ApiOkResponse({ type: ChatLabelResponseDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, nombre vacío, de más de 30 caracteres o en más de una línea, color fuera de la paleta',
  })
  @ApiForbiddenResponse({ description: SIN_PERMISO_DE_ESCRITURA })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description: 'Ya hay otra vigente con ese nombre (`CHAT_LABEL_NAME_TAKEN`)',
  })
  async actualizar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChatLabelDto,
  ): Promise<ChatLabelResponseDto> {
    return etiquetaADto(
      await this.etiquetas.actualizar(distributorId, id, dto),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('mensajes.configurar')
  @ApiOperation({
    summary: 'Dar de baja una etiqueta',
    description:
      'Baja lógica: deja de ofrecerse y sale de las conversaciones que la tenían (también queda fuera de las métricas). El nombre queda libre para otra. Queda en la auditoría.',
  })
  @ApiNoContentResponse({ description: 'Dada de baja' })
  @ApiBadRequestResponse({ description: 'Id que no es uuid' })
  @ApiForbiddenResponse({ description: SIN_PERMISO_DE_ESCRITURA })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async baja(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.etiquetas.darDeBaja(distributorId, id);
  }
}
