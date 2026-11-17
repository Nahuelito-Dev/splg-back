import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../../common/constants/role-type.enum';
import { Auth } from '../../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../../common/decorators/current-distributor.decorator';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Permiso } from '../../../common/decorators/permiso.decorator';
import { RequiereModulo } from '../../../platform/access/requiere-modulo.decorator';
import { BandejaAcceso } from '../../application/bandeja-acceso';
import { EstadoDelEquipoService } from '../../application/estado-del-equipo.service';
import { UpdateMyChatStatusDto } from '../dto/bandeja-input.dto';
import { ChatStatusResponseDto } from '../dto/bandeja-response.dto';
import { estadoADto } from '../equipo.mapper';

const SIN_CANAL =
  'La cuenta no es del personal de una empresa, el rol no atiende ningún canal de mensajes (`PERMISSION_DENIED`) o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)';

/**
 * El estado propio en la bandeja de la empresa (8b): «en línea» (recibe
 * conversaciones por asignación automática) o «ausente». De cualquiera del
 * personal que atienda algún canal (`mensajes.clientes` o
 * `mensajes.choferes`). Módulo `chat`.
 */
@ApiTags('Inbox (company)')
@RequiereModulo('chat')
@Permiso('mensajes.clientes', 'mensajes.choferes')
@Auth(RoleType.ADMIN)
@Controller({ path: 'me/chat-status', version: '2' })
export class MyChatStatusController {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly estado: EstadoDelEquipoService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Mi estado en la bandeja',
    description:
      '`available` = `online`, conectada al panel (o desconectada hace menos de 2 minutos: se conserva el estado elegido) y dentro del horario de atención de la empresa. `maxOpen` es el tope que rige (el propio o el de la empresa); `openAssigned`, las abiertas asignadas de los dos canales.',
  })
  @ApiOkResponse({ type: ChatStatusResponseDto })
  @ApiForbiddenResponse({ description: SIN_CANAL })
  async leer(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ChatStatusResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    return estadoADto(await this.estado.mio(actor));
  }

  @Put()
  @ApiOperation({
    summary: 'Ponerme en línea o ausente',
    description:
      'Ponerse `online` dispara el reparto de lo que espera a una persona (si la asignación automática está prendida) sin esperarlo: lo que reciba llega por el socket (`chat:conversation`, `chat:inbox`, `chat:team`) y lo cuenta el próximo `GET`. Avisa `chat:team` al equipo. Queda en la auditoría.',
  })
  @ApiOkResponse({ type: ChatStatusResponseDto })
  @ApiBadRequestResponse({
    description: '`status` falta o no es `online` ni `away`',
  })
  @ApiForbiddenResponse({ description: SIN_CANAL })
  async cambiar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Body() dto: UpdateMyChatStatusDto,
  ): Promise<ChatStatusResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    return estadoADto(await this.estado.cambiarElMio(actor, dto.status));
  }
}
