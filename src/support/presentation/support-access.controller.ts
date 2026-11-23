import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { SupportAccessService } from '../application/support-access.service';
import { SupportSessionsService } from '../application/support-sessions.service';
import { ApproveSupportAccessDto } from './dto/approve-support-access.dto';
import {
  QuerySupportAccessDto,
  SupportPaginationDto,
} from './dto/query-support-sessions.dto';
import { RejectSupportAccessDto } from './dto/reject-support-access.dto';
import {
  SupportAccessListResponseDto,
  SupportPolicyResponseDto,
  SupportSessionListResponseDto,
  SupportSessionResponseDto,
} from './dto/support-session-response.dto';
import { UpdateSupportPolicyDto } from './dto/update-support-policy.dto';
import { SupportMapper } from './support.mapper';
import { SupportSessionPresenter } from './support-session.presenter';

/**
 * Modo soporte, lado de la empresa: «Accesos de soporte» del panel (API v2,
 * sólo `admin`; el tenant es el de su perfil). Una sesión de otra empresa es
 * 404. El administrador general no entra acá: ni siquiera en modo soporte, que
 * es de sólo lectura y no puede aprobarse a sí mismo.
 */
@ApiTags('Support access')
@Auth(RoleType.ADMIN)
@Controller({ path: 'support-access', version: '2' })
export class SupportAccessController {
  constructor(
    private readonly service: SupportAccessService,
    private readonly sesiones: SupportSessionsService,
    private readonly presentar: SupportSessionPresenter,
  ) {}

  @Get()
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Pedidos y sesiones de soporte de mi empresa',
    description:
      'Pendientes primero; después, las más nuevas. Filtro opcional `status`, paginado.',
  })
  @ApiOkResponse({ type: SupportSessionListResponseDto })
  @ApiBadRequestResponse({
    description: 'Estado desconocido o paginación fuera de rango',
  })
  async listar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Query() query: QuerySupportAccessDto,
  ): Promise<SupportSessionListResponseDto> {
    const { items, total } = await this.service.listar(distributorId, query);
    return { items: await this.presentar.sesiones(items), total };
  }

  @Get('policy')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Política de soporte de mi empresa',
    description:
      'Si el soporte puede abrir accesos de emergencia (por defecto sí) y si los pedidos se aprueban solos (por defecto no).',
  })
  @ApiOkResponse({ type: SupportPolicyResponseDto })
  politica(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<SupportPolicyResponseDto> {
    return this.service.politica(distributorId);
  }

  @Put('policy')
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Cambiar la política de soporte de mi empresa',
    description: 'Lo que no viene en el cuerpo queda como estaba.',
  })
  @ApiOkResponse({ type: SupportPolicyResponseDto })
  @ApiBadRequestResponse({
    description: 'Un valor que no es verdadero o falso',
  })
  actualizarPolitica(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Body() dto: UpdateSupportPolicyDto,
  ): Promise<SupportPolicyResponseDto> {
    return this.service.actualizarPolitica(distributorId, dto);
  }

  @Get(':id')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Ficha de un pedido o sesión de soporte',
    description: 'Motivo, alcance, quién lo pidió, quién decidió y cuándo.',
  })
  @ApiOkResponse({ type: SupportSessionResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  async ficha(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportSessionResponseDto> {
    return this.presentar.sesion(await this.sesiones.ficha(id, distributorId));
  }

  @Get(':id/accesses')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Qué miró el soporte en una sesión',
    description: 'Una entrada por consulta, las más nuevas primero, paginado.',
  })
  @ApiOkResponse({ type: SupportAccessListResponseDto })
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o la paginación está fuera de rango',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  async accesos(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() paginacion: SupportPaginationDto,
  ): Promise<SupportAccessListResponseDto> {
    const { items, total } = await this.sesiones.accesos(
      id,
      paginacion,
      distributorId,
    );
    return { items: items.map((a) => SupportMapper.accesoToDto(a)), total };
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Aprobar un pedido de soporte',
    description:
      'Arranca el reloj. Se puede acortar la duración (`minutes`) y achicar el alcance (`scope`), nunca ampliarlos; sin valores, se aprueba tal como se pidió.',
  })
  @ApiOkResponse({ type: SupportSessionResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, o más minutos o más alcance que lo pedido (`SUPPORT_APPROVAL_EXCEEDS_REQUEST`)',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  @ApiConflictResponse({
    description:
      'Ya no está pendiente (`SUPPORT_SESSION_NOT_PENDING`), caducó (`SUPPORT_REQUEST_EXPIRED`) o quien la pidió ya tiene otra sesión activa (`SUPPORT_SESSION_ALREADY_ACTIVE`)',
  })
  async aprobar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveSupportAccessDto,
  ): Promise<SupportSessionResponseDto> {
    return this.presentar.sesion(
      await this.service.aprobar(distributorId, userId, id, dto),
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Permiso('soporte.gestionar')
  @ApiOperation({ summary: 'Rechazar un pedido de soporte' })
  @ApiOkResponse({ type: SupportSessionResponseDto })
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o la nota pasa de 500 caracteres',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  @ApiConflictResponse({
    description: 'Ya no está pendiente (`SUPPORT_SESSION_NOT_PENDING`)',
  })
  async rechazar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectSupportAccessDto,
  ): Promise<SupportSessionResponseDto> {
    return this.presentar.sesion(
      await this.service.rechazar(distributorId, userId, id, dto),
    );
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Revocar una sesión de soporte activa',
    description:
      'También las de emergencia. Vale desde la request siguiente del soporte.',
  })
  @ApiOkResponse({ type: SupportSessionResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  @ApiConflictResponse({
    description: 'No está activa (`SUPPORT_SESSION_ALREADY_ENDED`)',
  })
  async revocar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportSessionResponseDto> {
    return this.presentar.sesion(
      await this.service.revocar(distributorId, userId, id),
    );
  }
}
