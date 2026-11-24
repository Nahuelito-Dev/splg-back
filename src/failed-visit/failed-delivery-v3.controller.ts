import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { Order } from '../order/entities/order.entity';
import { OrderService } from '../order/order.service';
import { puedeResponderElCliente, RevisitStatus } from './domain/nueva-visita';
import { FailedDeliveryDto, RevisitChoiceDto } from './dto/failed-delivery.dto';
import {
  FailedDeliveryResponseDto,
  FailedVisitDto,
  FailedVisitOrdersPageDto,
  RevisitDayDto,
  RevisitStateDto,
} from './dto/failed-visit-response.dto';
import { QueryFailedVisitsDto } from './dto/query-failed-visits.dto';
import { FailedVisitQueryService } from './failed-visit-query.service';
import { FailedVisitNotifier } from './failed-visit.notifier';
import { FailedVisitService } from './failed-visit.service';
import { ReportFailedDeliveryUseCase } from './report-failed-delivery.use-case';

const PEDIDO_AJENO =
  'Pedido inexistente, de otro cliente o de otra distribuidora';

/** El estado de la nueva visita de un pedido (con la franja ya cargada). */
export function nuevaVisitaADto(pedido: Order): RevisitStateDto {
  const decideElAdmin = pedido.revisitStatus === RevisitStatus.AWAITING_ADMIN;
  const dto = new RevisitStateDto();
  dto.orderId = pedido.orderId;
  dto.status = (pedido.revisitStatus as RevisitStatus | null) ?? null;
  dto.failedVisitCount = pedido.failedVisitCount ?? 0;
  dto.scheduledDate = decideElAdmin ? null : (pedido.scheduledDate ?? null);
  dto.timeSlotId = decideElAdmin ? null : (pedido.timeSlotId ?? null);
  dto.timeSlotName = decideElAdmin ? null : (pedido.timeSlot?.name ?? null);
  dto.windowStart = decideElAdmin ? null : (pedido.timeSlot?.startTime ?? null);
  dto.windowEnd = decideElAdmin ? null : (pedido.timeSlot?.endTime ?? null);
  dto.canRespond = puedeResponderElCliente(pedido);
  return dto;
}

/**
 * Entrega fallida y nueva visita (C5, API v3), para todas las entregas: el
 * chofer informa «No pude entregar», el sistema propone cuándo volver, el
 * cliente acepta o elige otro día y el admin fija cuando le toca decidir.
 */
@ApiTags('Pedidos · Entrega fallida y nueva visita (v3)')
@Controller({ path: 'orders', version: '3' })
export class FailedDeliveryV3Controller {
  constructor(
    private readonly orders: OrderService,
    private readonly noPudeEntregar: ReportFailedDeliveryUseCase,
    private readonly visitas: FailedVisitService,
    private readonly consultas: FailedVisitQueryService,
    private readonly avisos: FailedVisitNotifier,
  ) {}

  @Post(':id/failed-delivery')
  @HttpCode(200)
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('pedidos.gestionar')
  @Idempotent()
  @ApiOperation({
    summary: '«No pude entregar»: informar una entrega fallida',
    description:
      'El chofer asignado informa por qué no pudo entregar (`reason`; `note` obligatoria con `other`) y su ubicación (queda el punto, la precisión, la distancia al domicilio y la hora, como en la confirmación de la entrega; fuera del radio de llegada no se rechaza: se marca). Opcional, `agreed`: el día y la franja que acordó con el cliente. Vale para todas las entregas. **Pedido suelto o express en camino**: vuelve a pendiente sin chofer y el sistema propone la nueva visita respetando el calendario y el cupo de las franjas — suelto: próximo día hábil con la franja original o la primera libre; express: la próxima franja libre de hoy o, si no hay, la primera del próximo día hábil. **Parada de una hoja de ruta en curso**: primer intento, vuelve al final del recorrido de hoy (`outcome: requeued`, no cuenta como visita fallida y no admite `agreed`); segundo, sale de la hoja y queda propuesta para el próximo día con hoja, con franja. A la segunda visita fallida del pedido (`failedVisitCount: 2`) el sistema deja de reprogramar: `outcome: awaiting_admin`. Hasta el inicio de la franja de la nueva visita el despacho no ofrece el pedido; ese día vuelve solo al circuito normal. El stock reservado y el pago no cambian (el efectivo se cobra en la nueva visita). Al cliente se le avisa por push, correo y socket (`order:rescheduled`, o `order:delivery-failed` si decide el admin); al panel, `order:failed-visit`. Un admin lo informa sin ubicación. Idempotente con `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: FailedDeliveryResponseDto })
  @ApiBadRequestResponse({
    description:
      'Motivo inválido, falta la nota con `other` o la ubicación del chofer (`code: VALIDATION`); el día acordado no es hábil o está fuera de las próximas dos semanas (`code: REVISIT_DAY_NOT_AVAILABLE`); super admin sin `X-Distributor`',
  })
  @ApiForbiddenResponse({
    description:
      'El pedido no está asignado a este chofer, o la cuenta no puede informar entregas fallidas',
  })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente o de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'El pedido no está en camino (`code: ORDER_NOT_ON_THE_WAY`); la franja acordada no tiene cupo (`code: REVISIT_SLOT_NOT_AVAILABLE`); `agreed` en el primer intento de una hoja de ruta (`code: REVISIT_AGREEMENT_NOT_ALLOWED`)',
  })
  async failedDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FailedDeliveryDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<FailedDeliveryResponseDto> {
    await this.orders.assertDeLaDistribuidora(id, distributorId);
    const r = await this.noPudeEntregar.execute({
      orderId: id,
      userId: user.user_id,
      role: user.role,
      reason: body.reason,
      note: body.note ?? null,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      accuracyMeters: body.accuracyMeters ?? null,
      agreed: body.agreed
        ? {
            date: body.agreed.scheduledDate,
            timeSlotId: body.agreed.timeSlotId,
          }
        : null,
    });
    const dto = new FailedDeliveryResponseDto();
    Object.assign(dto, nuevaVisitaADto(await this.visitas.pedido(id)));
    dto.failedVisitId = r.visit.failedVisitId;
    dto.outcome = r.outcome;
    dto.deliveryKind = r.deliveryKind;
    dto.nextOrderId = r.nextOrderId;
    return dto;
  }

  @Get(':id/failed-visits')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('pedidos.ver')
  @ApiOperation({
    summary: 'Historial de visitas fallidas del pedido',
    description:
      'De la más nueva a la más vieja: motivo, quién la informó, dónde estaba (punto, precisión, distancia al domicilio, fuera de radio), qué nueva visita se propuso o acordó y cómo se resolvió.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: [FailedVisitDto] })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente o de otra distribuidora',
  })
  async failedVisits(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<FailedVisitDto[]> {
    await this.pedidoDe(id, distributorId, null);
    return this.consultas.historial(id);
  }

  @Get(':id/revisit')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('pedidos.ver')
  @ApiOperation({
    summary: 'La nueva visita del pedido',
    description:
      'El día y la franja en que se vuelve a pasar después de una entrega fallida, y si el cliente todavía puede contestar (`canRespond`). `status: null` si el pedido no tuvo visitas fallidas. Con `awaiting_admin` no hay fecha: decide la distribuidora.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: RevisitStateDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: PEDIDO_AJENO })
  async revisit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RevisitStateDto> {
    return nuevaVisitaADto(await this.pedidoDe(id, distributorId, user));
  }

  @Get(':id/revisit/options')
  @Auth(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @Permiso('pedidos.ver')
  @ApiOperation({
    summary: 'Días y franjas libres para la nueva visita',
    description:
      'Los días en que la distribuidora reparte (su calendario, sin feriados) de las próximas dos semanas, cada uno con las franjas que todavía tienen cupo. Incluye hoy si es día hábil y queda alguna franja sin terminar con lugar, salvo para un pedido que salió de una hoja de ruta (entra en la hoja de otro día). Un día sin franjas libres no aparece. Lo usan el cliente para elegir otro día, el admin para fijarlo y el chofer asignado para «Acordé con el cliente»: `canAgree` (igual en todos los días) dice si se puede mandar un acuerdo; en el primer intento de una parada de hoja de ruta es `false`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: [RevisitDayDto] })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({
    description: `${PEDIDO_AJENO}, o que no está asignado a este chofer`,
  })
  async options(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RevisitDayDto[]> {
    return this.visitas.opciones(await this.pedidoDe(id, distributorId, user));
  }

  @Post(':id/revisit/accept')
  @HttpCode(200)
  @Auth(RoleType.CUSTOMER)
  @Idempotent({ sinCuerpo: true })
  @ApiOperation({
    summary: '«Me sirve»: el cliente acepta la nueva visita propuesta',
    description:
      'Deja confirmados el día y la franja propuestos. Repetirlo con la visita ya confirmada responde 200 sin cambios. Si el cliente no contesta, la propuesta queda igual.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: RevisitStateDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiForbiddenResponse({ description: 'Sólo el cliente dueño del pedido' })
  @ApiNotFoundResponse({ description: PEDIDO_AJENO })
  @ApiConflictResponse({
    description:
      'No hay una propuesta abierta: el pedido no tuvo una visita fallida, decide el admin, ya tiene chofer o se cerró (`code: REVISIT_NOT_OPEN`)',
  })
  async accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RevisitStateDto> {
    await this.pedidoDe(id, distributorId, user);
    // Sólo avisa la llamada que la confirmó: un «Me sirve» repetido o simultáneo no.
    const { cambio } = await this.visitas.aceptar(id, user.user_id);
    const pedido = await this.visitas.pedido(id);
    if (cambio) await this.avisos.respondida(pedido, false);
    return nuevaVisitaADto(pedido);
  }

  @Post(':id/revisit/choose')
  @HttpCode(200)
  @Auth(RoleType.CUSTOMER)
  @Idempotent()
  @ApiOperation({
    summary: '«Elegir otro día y horario»: el cliente cambia la nueva visita',
    description:
      'El cliente elige un día y una franja de `GET /orders/:id/revisit/options`. Se valida de nuevo el calendario y el cupo (con la franja bloqueada, como al crear un pedido). La visita queda confirmada y se le avisa al admin.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: RevisitStateDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, o el día no es hábil, ya pasó o está fuera de las próximas dos semanas (`code: REVISIT_DAY_NOT_AVAILABLE`)',
  })
  @ApiForbiddenResponse({ description: 'Sólo el cliente dueño del pedido' })
  @ApiNotFoundResponse({ description: PEDIDO_AJENO })
  @ApiConflictResponse({
    description:
      'No hay una propuesta abierta (`code: REVISIT_NOT_OPEN`); la franja ya no tiene cupo, terminó o no existe (`code: REVISIT_SLOT_NOT_AVAILABLE`); el pedido ya está en el recorrido de ese día (`code: REVISIT_ALREADY_PLANNED`)',
  })
  async choose(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevisitChoiceDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RevisitStateDto> {
    await this.pedidoDe(id, distributorId, user);
    await this.visitas.elegir(id, user.user_id, {
      date: body.scheduledDate,
      timeSlotId: body.timeSlotId,
    });
    const pedido = await this.visitas.pedido(id);
    await this.avisos.respondida(pedido, true);
    return nuevaVisitaADto(pedido);
  }

  @Post(':id/revisit/schedule')
  @HttpCode(200)
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('despacho.gestionar')
  @Idempotent()
  @ApiOperation({
    summary: 'El admin fija el día y la franja de la nueva visita',
    description:
      'Para un pedido pendiente sin chofer con una visita fallida, también cuando la decisión era del admin (`awaiting_admin`) o para cambiar lo propuesto. Valida el calendario y el cupo. La visita queda confirmada, el pedido vuelve al circuito normal al empezar esa franja y se le avisa al cliente (push, correo y socket). Para reasignarlo ya a un chofer o cancelarlo se usan los endpoints de siempre del pedido. Un super admin tiene que mandar `X-Distributor`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: RevisitStateDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, día no hábil o fuera de las próximas dos semanas (`code: REVISIT_DAY_NOT_AVAILABLE`), o super admin sin `X-Distributor` (`code: MISSING_DISTRIBUTOR`)',
  })
  @ApiNotFoundResponse({
    description: 'Pedido inexistente o de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'El pedido no tiene una nueva visita pendiente: no tuvo visitas fallidas, ya tiene chofer o se cerró (`code: REVISIT_NOT_OPEN`); franja sin cupo (`code: REVISIT_SLOT_NOT_AVAILABLE`); ya está en el recorrido de ese día (`code: REVISIT_ALREADY_PLANNED`)',
  })
  async schedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevisitChoiceDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<RevisitStateDto> {
    await this.pedidoDe(id, distributorId, null);
    await this.visitas.fijar(id, user.user_id, {
      date: body.scheduledDate,
      timeSlotId: body.timeSlotId,
    });
    const pedido = await this.visitas.pedido(id);
    await this.avisos.fijadaPorElAdmin(pedido);
    return nuevaVisitaADto(pedido);
  }

  /**
   * El pedido, si es de la distribuidora en contexto y —para un cliente— suyo,
   * o —para un chofer— uno que tiene asignado.
   * Lo ajeno responde 404, como si no existiera.
   */
  private async pedidoDe(
    id: string,
    distributorId: string | null,
    user: AuthenticatedUser | null,
  ): Promise<Order> {
    const pedido = await this.visitas.pedido(id);
    if (distributorId && pedido.distributorId !== distributorId) {
      throw new NotFoundException('Pedido no encontrado');
    }
    if (
      user?.role === RoleType.CUSTOMER &&
      pedido.customerId !== user.user_id
    ) {
      throw new NotFoundException('Pedido no encontrado');
    }
    // Un chofer sólo llega a los pedidos que tiene asignados.
    if (user?.role === RoleType.DELIVERY) {
      const propio =
        pedido.deliveryId !== null &&
        (await this.orders
          .assertEsElChofer(pedido.deliveryId, user.user_id)
          .then(() => true)
          .catch(() => false));
      if (!propio) throw new NotFoundException('Pedido no encontrado');
    }
    return pedido;
  }
}

/** Los pedidos con visitas fallidas, para el panel (C5, API v3). */
@ApiTags('Pedidos · Entrega fallida y nueva visita (v3)')
@Controller({ path: 'failed-visits', version: '3' })
export class FailedVisitsV3Controller {
  constructor(private readonly consultas: FailedVisitQueryService) {}

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Permiso('pedidos.ver')
  @ApiOperation({
    summary: 'Pedidos con visitas fallidas',
    description:
      'Un renglón por pedido con su última visita fallida, cuántas lleva y la nueva visita. Por omisión, los que siguen pendientes; primero los que esperan la decisión del admin. Filtra por estado de la nueva visita, motivo, fechas y cliente o número de pedido. Un super admin tiene que mandar `X-Distributor`.',
  })
  @ApiOkResponse({ type: FailedVisitOrdersPageDto })
  @ApiBadRequestResponse({
    description:
      'Filtros inválidos o super admin sin `X-Distributor` (`code: MISSING_DISTRIBUTOR`)',
  })
  list(
    @Query() query: QueryFailedVisitsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FailedVisitOrdersPageDto> {
    return this.consultas.listar(distributorId, query);
  }
}
