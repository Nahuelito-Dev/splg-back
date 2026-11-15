import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { SinControlDeAcceso } from '../../common/decorators/sin-control-de-acceso.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { PermisoDePlataforma } from '../../common/permisos/catalogo-de-plataforma';
import { SupportSummaryService } from '../application/support-summary.service';
import {
  CompanySupportSummaryDto,
  PlatformSupportSummaryDto,
} from './dto/chat-response.dto';

/** Insignia «Ayuda» del panel de la empresa (chat con la plataforma y tickets). Núcleo. */
@ApiTags('Platform chat (company)')
@Auth(RoleType.ADMIN)
@SinControlDeAcceso()
@Controller({ path: 'company/support', version: '2' })
export class CompanySupportSummaryController {
  constructor(private readonly resumen: SupportSummaryService) {}

  @Get('summary')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Contador de la ayuda de la plataforma',
    description:
      'Mensajes sin leer en el chat abierto y tickets con algo sin leer, para quien pide (la lectura es de cada persona). No cuenta mensajes de sistema ni los propios.',
  })
  @ApiOkResponse({ type: CompanySupportSummaryDto })
  resumenDeLaEmpresa(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CompanySupportSummaryDto> {
    return this.resumen.deLaEmpresa(distributorId, userId);
  }
}

/** Insignias del soporte en el panel de la plataforma. */
@ApiTags('Platform chat (platform)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/support', version: '2' })
export class PlatformSupportSummaryController {
  constructor(private readonly resumen: SupportSummaryService) {}

  @Get('summary')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Contadores del soporte',
    description:
      'Chats abiertos y tickets no cerrados con algo sin leer para quien pide, y los que nadie atiende.',
  })
  @ApiOkResponse({ type: PlatformSupportSummaryDto })
  resumenDeLaPlataforma(
    @CurrentUser('user_id') userId: string,
  ): Promise<PlatformSupportSummaryDto> {
    return this.resumen.deLaPlataforma(userId);
  }
}
