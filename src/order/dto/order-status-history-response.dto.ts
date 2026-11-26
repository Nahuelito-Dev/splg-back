import { ApiProperty } from '@nestjs/swagger';

const ESTADOS_PARA_APPS = [
  'reserved',
  'pending',
  'accepted',
  'out_for_delivery',
  'delivered',
  'cancelled',
];

export class HistorialDeEstadoActorDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({
    enum: ['customer', 'delivery', 'admin', 'super_admin'],
    nullable: true,
    description: 'Rol del usuario; `null` si la cuenta ya no tiene rol.',
  })
  role!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Nombre completo. Sólo lo ven admin y super admin; para el cliente y el chofer es `null`.',
  })
  fullName!: string | null;
}

export class OrderStatusHistoryEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: ESTADOS_PARA_APPS,
    nullable: true,
    description:
      'Estado de origen, con los mismos valores que `status` del pedido (`on_the_way` sale como `out_for_delivery`). `null` en el alta.',
  })
  fromStatus!: string | null;

  @ApiProperty({
    enum: ESTADOS_PARA_APPS,
    description: 'Estado de destino, con los mismos valores que `status`.',
  })
  toStatus!: string;

  @ApiProperty({
    description:
      '`true` si es una anotación y no un cambio de estado (origen = destino): los cobros manuales del admin (`register-cash`, `register-unpaid`) y la reasignación de un pedido aceptado a otro chofer (`accepted → accepted`, motivo «Reasignación de chofer»). Mostrarla como nota.',
  })
  isNote!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Motivo: cancelación, entrega manual o texto del cobro manual.',
  })
  reason!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  changedAt!: Date;

  @ApiProperty({
    type: HistorialDeEstadoActorDto,
    nullable: true,
    description:
      'Quién lo hizo. `null` si lo hizo el sistema (vencimiento, webhook) o la cuenta se dio de baja.',
  })
  changedBy!: HistorialDeEstadoActorDto | null;
}
