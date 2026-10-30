import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { SoloLectura } from '../audit/solo-lectura.decorator';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import {
  PeoplePhotosRequestDto,
  PeoplePhotosResponseDto,
} from './dto/people-photos.dto';
import { PeoplePhotosService } from './people-photos.service';

@ApiTags('People')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'people', version: '2' })
export class PeoplePhotosController {
  constructor(private readonly service: PeoplePhotosService) {}

  @Post('photos')
  @SoloLectura()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fotos de perfil de varias personas en un solo pedido',
    description:
      'Para dibujar avatares en listados y fichas. Devuelve, por cada id de ' +
      'usuario, legajo y chofer (`delivery_id`) pedido (hasta 100 de cada uno), la URL firmada y su ' +
      'vencimiento, o `null` si no tiene foto. Un admin de empresa sólo recibe ' +
      'las fotos de su gente (clientes, choferes, admins y legajos de su ' +
      'distribuidora): el resto, y los ids que no existen, vienen `null` sin ' +
      'error. Siempre recibe la suya. El super admin ve todo, o lo de la distribuidora de `X-Distributor`.',
  })
  @ApiOkResponse({ type: PeoplePhotosResponseDto })
  @ApiBadRequestResponse({
    description: 'Ids que no son UUID, o más de 100',
  })
  firmar(
    @Body() dto: PeoplePhotosRequestDto,
    @CurrentDistributor() distributorId: string | null,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PeoplePhotosResponseDto> {
    return this.service.firmar(
      dto.userIds,
      dto.employeeIds ?? [],
      dto.deliveryIds ?? [],
      distributorId,
      user.user_id,
    );
  }
}
