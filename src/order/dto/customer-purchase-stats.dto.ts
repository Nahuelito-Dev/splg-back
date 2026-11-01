import { ApiProperty } from '@nestjs/swagger';

/** Lo que un cliente le compró a la distribuidora, calculado en la base sobre todos sus pedidos. */
export class CustomerPurchaseStatsDto {
  @ApiProperty({
    example: 184500,
    description:
      'Suma del total de los pedidos entregados (los cancelados y los que siguen en curso no cuentan como compra)',
  })
  totalPurchased!: number;

  @ApiProperty({
    example: 12,
    description: 'Cuántos pedidos tiene en total, de cualquier estado',
  })
  ordersCount!: number;

  @ApiProperty({ example: 9, description: 'Cuántos de esos están entregados' })
  deliveredCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 20500,
    description:
      'Ticket promedio: lo comprado dividido los pedidos entregados, a 2 decimales; `null` si todavía no recibió ninguno',
  })
  averageTicket!: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo se entregó el último pedido entregado; `null` si no tiene ninguno',
  })
  lastDeliveredAt!: Date | null;
}
