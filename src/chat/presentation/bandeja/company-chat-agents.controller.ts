import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
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
import { EstadoDelEquipoService } from '../../application/estado-del-equipo.service';
import { UpdateChatAgentDto } from '../dto/bandeja-input.dto';
import {
  ChatAgentDto,
  ChatAgentListResponseDto,
} from '../dto/bandeja-response.dto';
import { agenteADto } from '../equipo.mapper';

/**
 * El equipo de la bandeja de la empresa (8b): el tablero de quién está en
 * línea, conectado, disponible y con cuántas abiertas, para quien supervisa
 * o configura; y el tope propio de cada persona (`mensajes.configurar`).
 * Módulo `chat`.
 */
@ApiTags('Inbox settings (company)')
@RequiereModulo('chat')
@Permiso('mensajes.supervisar', 'mensajes.configurar')
@Auth(RoleType.ADMIN)
@Controller({ path: 'chat/agents', version: '2' })
export class CompanyChatAgentsController {
  constructor(private readonly estado: EstadoDelEquipoService) {}

  @Get()
  @ApiOperation({
    summary: 'El equipo de la bandeja',
    description:
      'Las personas del personal de la empresa que atienden algún canal (`mensajes.clientes` o `mensajes.choferes`), por nombre, con su estado, conexión, disponibilidad, tope, abiertas asignadas, canales y la última vez que recibieron una sola. Sin email ni teléfono. En vivo: `chat:team` por el socket.',
  })
  @ApiOkResponse({ type: ChatAgentListResponseDto })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es del personal de una empresa, el rol no tiene `mensajes.supervisar` ni `mensajes.configurar` (`PERMISSION_DENIED`) o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)',
  })
  async listar(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ChatAgentListResponseDto> {
    return {
      items: (await this.estado.listar(distributorId)).map(agenteADto),
    };
  }

  @Put(':userId')
  @Permiso('mensajes.configurar')
  @ApiOperation({
    summary: 'El tope propio de una persona del equipo',
    description:
      '`maxOpenOverride` de 1 a 50, o `null` para volver al de la empresa. Cambiarlo dispara el reparto de lo que espera a una persona (no lo espera: lo asignado llega por el socket). Avisa `chat:team`. Queda en la auditoría.',
  })
  @ApiOkResponse({ type: ChatAgentDto })
  @ApiBadRequestResponse({
    description:
      '`userId` que no es uuid (`INVALID_ID`), o `maxOpenOverride` que falta, no es entero o está fuera de 1–50',
  })
  @ApiForbiddenResponse({
    description:
      'Sin `mensajes.configurar` (`PERMISSION_DENIED`), la cuenta no es del personal o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)',
  })
  @ApiNotFoundResponse({
    description:
      'La persona no es del equipo de la bandeja de la empresa: de otra empresa, dada de baja o bloqueada, o sin permiso de ningún canal',
  })
  async cambiarTope(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateChatAgentDto,
  ): Promise<ChatAgentDto> {
    return agenteADto(
      await this.estado.cambiarTope(distributorId, userId, dto.maxOpenOverride),
    );
  }
}
