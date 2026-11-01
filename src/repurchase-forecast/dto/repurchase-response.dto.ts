import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderResponseDto } from '../../order/dto/order-response.dto';
import { PaymentMethod } from '../../order/entities/order.entity';
import {
  RepurchaseEstimateSource,
  RepurchaseInvitationStatus,
} from '../entities/repurchase-invitation.entity';

export class InvitationItemDto {
  @ApiProperty({ format: 'uuid' }) gasCylinderId!: string;
  @ApiProperty({ example: '10kg' }) type!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({
    description:
      'Precio de lista de hoy, sin promoción (es 0 si el producto ya no existe)',
  })
  listUnitPrice!: number;
  @ApiProperty({
    description:
      'Precio unitario de hoy con la promoción por volumen que alcanza la cantidad: el mismo que cotiza el pedido',
  })
  unitPrice!: number;
  @ApiProperty({
    description:
      'Cantidad por precio unitario con promoción (sin recargos de zona ni de pago)',
  })
  subtotal!: number;
  @ApiProperty({
    description:
      'false: el producto se dio de baja o ya no hay stock para la cantidad',
  })
  available!: boolean;
}

export class InvitationAddressDto {
  @ApiProperty({ format: 'uuid' }) addressId!: string;
  @ApiProperty({ example: 'Av. Corrientes 1234, Posadas' }) label!: string;
}

export class InvitationTimeSlotDto {
  @ApiProperty({ format: 'uuid' }) timeSlotId!: string;
  @ApiProperty({ example: 'Mañana' }) name!: string;
  @ApiProperty({ example: '09:00' }) startTime!: string;
  @ApiProperty({ example: '13:00' }) endTime!: string;
}

/** La invitación como la ve el cliente: el pedido precargado, listo para confirmar. */
export class RepurchaseInvitationResponseDto {
  @ApiProperty({ format: 'uuid' }) invitationId!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty({ enum: RepurchaseInvitationStatus })
  status!: RepurchaseInvitationStatus;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo se estima que se le acaba el gas',
  })
  projectedDepletionAt!: Date;
  @ApiProperty({
    enum: RepurchaseEstimateSource,
    description: 'Con qué se estimó: sus compras o el consumo que declaró',
  })
  estimateSource!: RepurchaseEstimateSource;
  @ApiProperty({ type: [InvitationItemDto] }) items!: InvitationItemDto[];
  @ApiProperty({
    description:
      'Suma de los subtotales con promoción; el total real (con zona y recargos) se cotiza con `POST /orders/quote`',
  })
  estimatedTotal!: number;
  @ApiProperty({ type: InvitationAddressDto, nullable: true })
  address!: InvitationAddressDto | null;
  @ApiProperty({
    type: InvitationTimeSlotDto,
    nullable: true,
    description: 'Su franja habitual, si todavía está activa',
  })
  timeSlot!: InvitationTimeSlotDto | null;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Hasta cuándo se puede aceptar',
  })
  expiresAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt!: Date | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'El pedido que creó, si la aceptó',
  })
  orderId!: string | null;
}

export class AcceptInvitationResponseDto {
  @ApiProperty({ type: RepurchaseInvitationResponseDto })
  invitation!: RepurchaseInvitationResponseDto;
  @ApiProperty({
    type: OrderResponseDto,
    description:
      'El pedido creado, con el mismo contrato de `POST /orders` (incluye `paymentUrl` si se paga con MercadoPago)',
  })
  order!: OrderResponseDto;
}

export class RepurchaseCustomerRefDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'El perfil de cliente: con él se abre su ficha (`/customers/:id`)',
  })
  customerId!: string | null;
  @ApiProperty({ format: 'uuid', description: 'La cuenta del cliente' })
  userId!: string;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: String, nullable: true }) phoneNumber!: string | null;
}

/** Una invitación en el listado del administrador. */
export class AdminInvitationResponseDto {
  @ApiProperty({ format: 'uuid' }) invitationId!: string;
  @ApiProperty({ enum: RepurchaseInvitationStatus })
  status!: RepurchaseInvitationStatus;
  @ApiProperty({ type: RepurchaseCustomerRefDto })
  customer!: RepurchaseCustomerRefDto;
  @ApiProperty({ type: String, format: 'date-time' })
  projectedDepletionAt!: Date;
  @ApiProperty({ enum: RepurchaseEstimateSource })
  estimateSource!: RepurchaseEstimateSource;
  @ApiProperty({ description: 'Garrafas que se le ofrecieron' })
  totalUnits!: number;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) orderId!:
    | string
    | null;
}

export class AdminInvitationPageDto {
  @ApiProperty({ type: [AdminInvitationResponseDto] })
  data!: AdminInvitationResponseDto[];
  @ApiProperty() total!: number;
}

export class RepurchaseStatsResponseDto {
  @ApiProperty({ type: String, format: 'date-time' }) from!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) to!: Date;
  @ApiProperty({ description: 'Invitaciones emitidas en el período' })
  sent!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() accepted!: number;
  @ApiProperty() rejected!: number;
  @ApiProperty() expired!: number;
  @ApiProperty({
    description: 'Se cerraron sin efecto: el cliente compró por su cuenta',
  })
  cancelled!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Aceptadas sobre las que ya tuvieron resolución (aceptadas, descartadas y vencidas), de 0 a 1. `null` si todavía no hay ninguna',
  })
  conversionRate!: number | null;
  @ApiProperty({
    description:
      'Total de los pedidos que crearon las aceptadas (sin los cancelados)',
  })
  acceptedRevenue!: number;
}

export class RepurchaseOpenInvitationRefDto {
  @ApiProperty({ format: 'uuid' }) invitationId!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
}

/** Un cliente al que se le acaba el gas dentro de la ventana (CU-146). */
export class RepurchaseForecastRowDto {
  @ApiProperty({ type: RepurchaseCustomerRefDto })
  customer!: RepurchaseCustomerRefDto;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo se estima que se le acaba el gas',
  })
  estimatedAt!: Date;
  @ApiProperty({
    description: 'Días que faltan; negativo si ya se pasó de la fecha',
  })
  daysLeft!: number;
  @ApiProperty({
    enum: RepurchaseEstimateSource,
    description: '`history`: sus compras; `declared`: el consumo que declaró',
  })
  source!: RepurchaseEstimateSource;
  @ApiProperty({ description: 'Compras que entraron en la estimación' })
  ordersUsed!: number;
  @ApiProperty({ type: String, format: 'date-time' }) lastPurchaseAt!: Date;
  @ApiProperty({ description: 'Kilos de gas de su última compra' })
  lastPurchaseKg!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Kilos por mes que declaró',
  })
  declaredKgPerMonth!: number | null;
  @ApiProperty({ description: 'Kilos por mes que se le estiman' })
  estimatedKgPerMonth!: number;
  @ApiProperty({
    description: 'Garrafas que suele pedir (las de su última compra)',
  })
  usualUnits!: number;
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Productos de su última compra',
  })
  usualCylinderIds!: string[];
  @ApiProperty() noticeEnabled!: boolean;
  @ApiProperty({ description: 'Días de anticipación que rigen para él' })
  noticeDays!: number;
  @ApiProperty({ type: RepurchaseOpenInvitationRefDto, nullable: true })
  openInvitation!: RepurchaseOpenInvitationRefDto | null;
}

export class RepurchaseForecastPageDto {
  @ApiProperty({ type: [RepurchaseForecastRowDto] })
  data!: RepurchaseForecastRowDto[];
  @ApiProperty({ description: 'Clientes dentro de la ventana' }) total!: number;
  @ApiProperty() days!: number;
  @ApiProperty({ type: String, format: 'date-time' }) generatedAt!: Date;
}

/** La estimación de un cliente (ficha del cliente en el panel). */
export class RepurchaseCustomerForecastDto {
  @ApiProperty({ type: RepurchaseForecastRowDto, nullable: true })
  forecast!: RepurchaseForecastRowDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [
      'no_purchases',
      'insufficient_history',
      'irregular_history',
      'stale',
    ],
    description: 'Por qué no se lo puede proyectar, si `forecast` es null',
  })
  reason!: string | null;
}

export class RepurchaseNoticeResponseDto {
  @ApiProperty({ description: 'false: no quiere recibir el aviso' })
  enabled!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Los días que eligió; `null`: rige el valor de la distribuidora',
  })
  days!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'El valor de la distribuidora del header `X-Distributor`; `null` sin header',
  })
  distributorDays!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Los días que rigen: `days` o, sin elegir, `distributorDays`',
  })
  effectiveDays!: number | null;
}

/** La fecha estimada de recompra del propio cliente en una distribuidora. */
export class MyRepurchaseResponseDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  estimatedAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) daysLeft!: number | null;
  @ApiProperty({ enum: RepurchaseEstimateSource, nullable: true })
  source!: RepurchaseEstimateSource | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Por qué no hay estimación: `no_purchases` (nunca le compró a esta distribuidora), `insufficient_history`, `irregular_history` o `stale`',
  })
  reason!: string | null;
  @ApiProperty({ type: RepurchaseNoticeResponseDto })
  notice!: RepurchaseNoticeResponseDto;
  @ApiPropertyOptional({
    type: RepurchaseInvitationResponseDto,
    nullable: true,
    description: 'Su invitación abierta, si tiene',
  })
  openInvitation!: RepurchaseInvitationResponseDto | null;
}

export class RepurchaseRunCandidateDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  projectedDepletionAt!: Date;
  @ApiProperty({ enum: RepurchaseEstimateSource })
  source!: RepurchaseEstimateSource;
  @ApiProperty() totalUnits!: number;
}

export class RepurchaseRunResponseDto {
  @ApiProperty({ description: 'Clientes con una fecha estimada' })
  evaluated!: number;
  @ApiProperty({
    description: 'Invitaciones emitidas (o que se emitirían con `dryRun`)',
  })
  invited!: number;
  @ApiProperty({ description: 'Invitaciones abiertas que vencieron' })
  expired!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description:
      'Por qué no se invitó a los demás, con cuántos: notice_disabled, not_yet, recent_order, cooldown, no_stock, no_address',
    example: { not_yet: 12, cooldown: 1 },
  })
  skipped!: Record<string, number>;
  @ApiProperty({
    type: [RepurchaseRunCandidateDto],
    description: 'Con `dryRun`, a quién se invitaría',
  })
  candidates!: RepurchaseRunCandidateDto[];
}
