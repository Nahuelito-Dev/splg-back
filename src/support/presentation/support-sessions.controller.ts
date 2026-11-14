import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { SupportSessionsService } from '../application/support-sessions.service';
import { CreateSupportSessionDto } from './dto/create-support-session.dto';
import { EndSupportSessionDto } from './dto/end-support-session.dto';
import {
  QuerySupportSessionsDto,
  SupportPaginationDto,
} from './dto/query-support-sessions.dto';
import {
  SupportAccessListResponseDto,
  SupportSessionCurrentResponseDto,
  SupportSessionListResponseDto,
  SupportSessionResponseDto,
} from './dto/support-session-response.dto';
import { SupportMapper } from './support.mapper';

/**
 * Modo soporte, lado de la plataforma (API v2, sólo `super_admin`, alcance
 * `plataforma`). `@SinDistribuidora()`: estas rutas no leen `X-Distributor` ni
 * `X-Support-Session`, así el panel siempre puede consultar la sesión actual y
 * salir, aunque mande el encabezado de una sesión que ya terminó.
 */
@ApiTags('Support sessions')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'support-sessions', version: '2' })
export class SupportSessionsController {
  constructor(private readonly service: SupportSessionsService) {}

  @Post()
  @ApiOperation({
    summary: 'Pedir acceso de soporte a una empresa',
    description:
      'Consentido: queda `pending` hasta que la empresa lo apruebe (caduca en 24 h), salvo que la empresa tenga la autoaprobación prendida (`active` al instante). Emergencia (`emergency: true`): `active` al instante, hasta 60 minutos, con aviso inmediato a la empresa. En los tres casos la empresa recibe un aviso en la bandeja y por correo.',
  })
  @ApiCreatedResponse({ type: SupportSessionResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos: empresa que no es un UUID, motivo de menos de 20 o más de 1000 caracteres, duración que no es 15, 30, 60 o 120 minutos (o más de 60 en emergencia), alcance desconocido o repetido',
  })
  @ApiForbiddenResponse({
    description:
      'No es administrador general, o emergencia que la empresa no permite (`SUPPORT_EMERGENCY_DISABLED`)',
  })
  @ApiNotFoundResponse({
    description: 'La empresa no existe o está dada de baja',
  })
  @ApiConflictResponse({
    description:
      'Ya tiene una sesión activa (`SUPPORT_SESSION_ALREADY_ACTIVE`), ya hay un pedido pendiente para esa empresa (`SUPPORT_REQUEST_ALREADY_PENDING`) o la empresa está suspendida (`SUPPORT_COMPANY_SUSPENDED`)',
  })
  async pedir(
    @CurrentUser('user_id') userId: string,
    @Body() dto: CreateSupportSessionDto,
  ): Promise<SupportSessionResponseDto> {
    return SupportMapper.toDto(await this.service.pedir(userId, dto));
  }

  @Get('current')
  @ApiOperation({
    summary: 'Mi sesión de soporte actual',
    description:
      'La activa (en plazo) o, si no hay, el pedido pendiente más nuevo, en `session`; `session: null` si no tengo ninguna. El panel la consulta al iniciar y cada 30 segundos.',
  })
  @ApiOkResponse({ type: SupportSessionCurrentResponseDto })
  async actual(
    @CurrentUser('user_id') userId: string,
  ): Promise<SupportSessionCurrentResponseDto> {
    const sesion = await this.service.actual(userId);
    return { session: sesion ? SupportMapper.toDto(sesion) : null };
  }

  @Get()
  @ApiOperation({
    summary: 'Historial de sesiones de soporte de la plataforma',
    description:
      'Las más nuevas primero, paginado. Filtros: `status`, `distributorId`, `requestedBy`, `from` y `to` (ISO 8601, sobre la fecha del pedido).',
  })
  @ApiOkResponse({ type: SupportSessionListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido: estado desconocido, ids que no son UUID, fechas que no son ISO 8601 o «desde» posterior a «hasta», paginación fuera de rango',
  })
  async listar(
    @Query() query: QuerySupportSessionsDto,
  ): Promise<SupportSessionListResponseDto> {
    const { items, total } = await this.service.listar(query);
    return { items: items.map((s) => SupportMapper.toDto(s)), total };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ficha de una sesión de soporte' })
  @ApiOkResponse({ type: SupportSessionResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe esa sesión' })
  async ficha(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportSessionResponseDto> {
    return SupportMapper.toDto(await this.service.ficha(id));
  }

  @Get(':id/accesses')
  @ApiOperation({
    summary: 'Lo que se miró en una sesión de soporte',
    description: 'Una entrada por consulta, las más nuevas primero, paginado.',
  })
  @ApiOkResponse({ type: SupportAccessListResponseDto })
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o la paginación está fuera de rango',
  })
  @ApiNotFoundResponse({ description: 'No existe esa sesión' })
  async accesos(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() paginacion: SupportPaginationDto,
  ): Promise<SupportAccessListResponseDto> {
    const { items, total } = await this.service.accesos(id, paginacion);
    return { items: items.map((a) => SupportMapper.accesoToDto(a)), total };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Salir del modo soporte o retirar el pedido',
    description:
      'La propia: activa → `ended` (salir), pendiente → `cancelled` (retirar). La de otro administrador general: activa → `revoked` (`revoked_by_platform`), pendiente → `cancelled`, con `reason` obligatorio. Una activa ya vencida queda `expired`.',
  })
  @ApiBody({ type: EndSupportSessionDto, required: false })
  @ApiNoContentResponse({ description: 'Sesión cerrada o pedido retirado' })
  @ApiBadRequestResponse({
    description:
      'El id no es un UUID, o falta el motivo (o tiene menos de 20 caracteres) para cortar la de otro',
  })
  @ApiNotFoundResponse({ description: 'No existe esa sesión' })
  @ApiConflictResponse({
    description: 'Ya terminó (`SUPPORT_SESSION_ALREADY_ENDED`)',
  })
  async terminar(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndSupportSessionDto,
  ): Promise<void> {
    await this.service.terminar(userId, id, dto ?? new EndSupportSessionDto());
  }
}
