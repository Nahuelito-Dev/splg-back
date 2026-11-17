import { Controller, Get } from '@nestjs/common';
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
import { RequiereModulo } from '../../../platform/access/requiere-modulo.decorator';
import { BandejaAcceso } from '../../application/bandeja-acceso';
import { TiempoEsperadoService } from '../../application/tiempo-esperado.service';
import { ExpectedReplyResponseDto } from '../dto/bandeja-response.dto';
import { tiempoEsperadoADto } from '../tiempo-esperado.mapper';

/**
 * El tiempo de respuesta esperado que ven el cliente (C3) y el chofer (C2)
 * antes de escribir (tanda 7c). Va en su propio controlador y se registra
 * ANTES que `MyConversationsController` en el módulo: si no, la ruta
 * `me/conversations/:id` (con `ParseUUIDPipe`) se queda con `expected-reply`.
 */
@ApiTags('Inbox (apps)')
@RequiereModulo('chat')
@Auth(RoleType.CUSTOMER, RoleType.DELIVERY)
@Controller({ path: 'me/conversations', version: '2' })
export class MyExpectedReplyController {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly esperado: TiempoEsperadoService,
  ) {}

  @Get('expected-reply')
  @ApiOperation({
    summary: 'Tiempo de respuesta esperado',
    description:
      'Para mostrar antes de escribir: «Solemos responder en ~N min» con la mediana de la primera respuesta (en horario de atención) de los últimos 14 días del canal (el cliente, el de clientes de la empresa del `X-Distributor`; el chofer, el de choferes de la suya), o el objetivo de la empresa si hubo menos de 10 respondidas. Fuera de horario: «Ahora estamos fuera de horario. Te respondemos …» con `nextOpenAt`. Si la empresa lo apagó (o, para el cliente, no atiende por chat), `enabled: false` y el resto vacío. Se recalcula cada 10 minutos.',
  })
  @ApiOkResponse({ type: ExpectedReplyResponseDto })
  @ApiBadRequestResponse({
    description: 'El cliente sin `X-Distributor` (`MISSING_DISTRIBUTOR`)',
  })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente o un chofer, o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)',
  })
  async tiempoEsperado(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ExpectedReplyResponseDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    return tiempoEsperadoADto(
      await this.esperado.delCanal(distributorId, actor.canales[0]),
    );
  }
}
