import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { UpdateRepurchaseNoticeDto } from './dto/repurchase-request.dto';
import {
  AcceptInvitationResponseDto,
  MyRepurchaseResponseDto,
  RepurchaseInvitationResponseDto,
  RepurchaseNoticeResponseDto,
} from './dto/repurchase-response.dto';
import { RepurchaseAcceptService } from './repurchase-accept.service';
import { RepurchaseCustomerService } from './repurchase-customer.service';
import { RepurchaseMapper } from './repurchase.mapper';

/**
 * Recompra anticipada en la app del cliente (CU-106, CU-145 y CU-146): su fecha
 * estimada, cómo quiere el aviso y las invitaciones a reponer con el pedido
 * precargado. Todo es del cliente autenticado: la invitación de otro es un 404.
 * Las invitaciones nuevas llegan por el socket `repurchase:invitation` y por
 * push (`data.event = REPURCHASE_INVITATION`).
 */
@ApiTags('Customers · Repurchase (v2)')
@Auth(RoleType.CUSTOMER)
@Controller({ path: 'customers/me/repurchase', version: '2' })
export class RepurchaseCustomerController {
  constructor(
    private readonly customer: RepurchaseCustomerService,
    private readonly accept: RepurchaseAcceptService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Mi fecha estimada de recompra en una distribuidora',
    description:
      'Cuándo se estima que se me acaba el gas con la distribuidora del header `X-Distributor` (obligatorio), con qué se estimó, mi preferencia de aviso y mi invitación abierta si tengo. Sin estimación (`estimatedAt: null`) explica por qué en `reason`.',
  })
  @ApiOkResponse({ type: MyRepurchaseResponseDto })
  @ApiBadRequestResponse({ description: 'Falta X-Distributor' })
  async miRecompra(
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MyRepurchaseResponseDto> {
    const ahora = new Date();
    return RepurchaseMapper.mine(
      await this.customer.miRecompra(userId, distributorId, ahora),
      ahora,
    );
  }

  @Get('notice')
  @ApiOperation({
    summary: 'Mi preferencia de aviso de recompra (CU-145)',
    description:
      'Si el aviso está activado y con cuántos días de anticipación. Con `X-Distributor` suma el valor de esa distribuidora, que rige si no elegí.',
  })
  @ApiOkResponse({ type: RepurchaseNoticeResponseDto })
  async aviso(
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RepurchaseNoticeResponseDto> {
    return RepurchaseMapper.notice(
      await this.customer.aviso(userId, distributorId),
    );
  }

  @Patch('notice')
  @ApiOperation({
    summary: 'Elegir cómo quiero el aviso de recompra (CU-145)',
    description:
      '`days` (1 a 30) son los días de anticipación con los que quiero que me avisen; `null` vuelve al valor de la distribuidora. `enabled: false` desactiva el aviso (no borra la estimación). Sólo cambia lo que viene; al menos un campo.',
  })
  @ApiOkResponse({ type: RepurchaseNoticeResponseDto })
  @ApiBadRequestResponse({
    description: 'days fuera de 1 a 30, no entero, o cuerpo vacío',
  })
  async actualizarAviso(
    @Body() dto: UpdateRepurchaseNoticeDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RepurchaseNoticeResponseDto> {
    return RepurchaseMapper.notice(
      await this.customer.actualizarAviso(userId, dto, distributorId),
    );
  }

  @Get('invitations')
  @ApiOperation({
    summary: 'Mis invitaciones de recompra',
    description:
      'Por omisión las abiertas y vigentes; con `all=true`, también las que ya se resolvieron (hasta 50, la más nueva primero). Con `X-Distributor`, sólo las de esa distribuidora. Cada una trae el pedido precargado a precios de hoy.',
  })
  @ApiQuery({ name: 'all', required: false, type: Boolean })
  @ApiOkResponse({ type: [RepurchaseInvitationResponseDto] })
  async invitaciones(
    @Query('all') todas: string | undefined,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RepurchaseInvitationResponseDto[]> {
    const vistas = await this.customer.listar(
      userId,
      distributorId,
      todas !== 'true',
      new Date(),
    );
    return vistas.map((v) =>
      RepurchaseMapper.invitation(v.invitacion, v.detalle),
    );
  }

  @Get('invitations/:id')
  @ApiOperation({ summary: 'Una de mis invitaciones de recompra' })
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiOkResponse({ type: RepurchaseInvitationResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe o es de otro cliente' })
  async invitacion(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RepurchaseInvitationResponseDto> {
    const v = await this.customer.una(userId, id);
    return RepurchaseMapper.invitation(v.invitacion, v.detalle);
  }

  @Post('invitations/:id/accept')
  @Idempotent()
  @ApiOperation({
    summary: 'Aceptar una invitación: crear el pedido',
    description:
      'Crea el pedido precargado por el mismo camino que `POST /orders` (reserva de stock, precio y promociones de hoy, recargos, despacho): el cuerpo es opcional y sólo cambia dirección de entrega, medio de pago, franja (`timeSlotId` y `scheduledDate` van juntos) o notas. Sin dirección usa la de la invitación; sin franja, la entrega es inmediata. Idempotente vía `Idempotency-Key`. Con MercadoPago, `order.paymentUrl` trae el enlace de cobro.',
  })
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiCreatedResponse({ type: AcceptInvitationResponseDto })
  @ApiBadRequestResponse({
    description:
      'El id no es un UUID, sin stock para lo sugerido, franja sin fecha (o al revés), dirección fuera de cobertura u otra regla del pedido',
  })
  @ApiNotFoundResponse({
    description:
      'No existe o es de otro cliente, o la dirección elegida no pertenece al cliente',
  })
  @ApiConflictResponse({
    description:
      'Ya aceptada, descartada, vencida, o cerrada porque ya hiciste un pedido',
  })
  async aceptar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptInvitationDto,
    @CurrentUser('user_id') userId: string,
  ): Promise<AcceptInvitationResponseDto> {
    const { invitation, order, paymentUrl } = await this.accept.aceptar(
      id,
      userId,
      dto,
    );
    const vista = await this.customer.conDetalle(invitation);
    return RepurchaseMapper.accepted(
      RepurchaseMapper.invitation(vista.invitacion, vista.detalle),
      order,
      paymentUrl,
    );
  }

  @Post('invitations/:id/dismiss')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Descartar una invitación',
    description:
      'Queda registrada como descartada: el sistema no vuelve a invitarme hasta pasado el intervalo mínimo de la distribuidora.',
  })
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiOkResponse({ type: RepurchaseInvitationResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe o es de otro cliente' })
  @ApiConflictResponse({ description: 'Ya no está abierta' })
  async descartar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<RepurchaseInvitationResponseDto> {
    const descartada = await this.accept.descartar(id, userId);
    const v = await this.customer.conDetalle(descartada);
    return RepurchaseMapper.invitation(v.invitacion, v.detalle);
  }
}
