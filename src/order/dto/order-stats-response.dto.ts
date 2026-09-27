import { ApiProperty } from '@nestjs/swagger';

/** Pedidos por estado para el tablero. */
export class ResumenDePedidosDto {
  @ApiProperty({ example: 27 }) pending!: number;
  @ApiProperty({ example: 7 }) accepted!: number;
  @ApiProperty({ example: 20 }) onTheWay!: number;
  @ApiProperty({ example: 2 }) deliveredToday!: number;
}

/**
 * Importe vendido (pedidos entregados) en cada período. `week` es la SEMANA
 * CALENDARIO (domingo a sábado en curso), no los últimos 7 días.
 */
export class VentasDto {
  @ApiProperty({ example: 22600 }) today!: number;
  @ApiProperty({
    example: 958500,
    description:
      'Semana calendario en curso (domingo a sábado), no los últimos 7 días',
  })
  week!: number;
  @ApiProperty({
    example: 1623100,
    description: 'Mes en curso (desde el día 1)',
  })
  month!: number;
  @ApiProperty({ example: 12561700 }) total!: number;
}

export class RendimientoDto {
  @ApiProperty({
    example: 11,
    description:
      'Choferes EN LÍNEA y listos para despachar (habilitado + validado + ' +
      'conectado en su app)',
  })
  activeDeliveries!: number;
  @ApiProperty({
    example: 15,
    description:
      'Choferes habilitados por un admin, estén o no en línea ni validados',
  })
  enabledDeliveries!: number;
  @ApiProperty({ example: 11300, description: 'Ticket promedio de hoy' })
  avgOrderValue!: number;
  @ApiProperty({
    example: 2,
    deprecated: true,
    description:
      'Deprecado: duplica exactamente `ordersSummary.deliveredToday`. Se ' +
      'mantiene por contrato, no se calcula distinto',
  })
  ordersPerDay!: number;
}

/** Medios de pago de los pedidos entregados en el MES EN CURSO (desde el día 1). */
export class MediosDePagoDto {
  @ApiProperty({ example: 88, description: 'Mes en curso' }) cash!: number;
  @ApiProperty({ example: 1, description: 'Mes en curso' })
  mercadopago!: number;
}

/** `GET /orders/stats/summary`: los números del tablero del panel. */
export class OrderStatsResponseDto {
  @ApiProperty({ type: ResumenDePedidosDto })
  ordersSummary!: ResumenDePedidosDto;
  @ApiProperty({ type: VentasDto }) sales!: VentasDto;
  @ApiProperty({ type: RendimientoDto }) performance!: RendimientoDto;
  @ApiProperty({ type: MediosDePagoDto }) paymentMethods!: MediosDePagoDto;
}

/** Un día del gráfico de ventas de `GET /orders/stats/chart`. */
export class SalesChartPointDto {
  @ApiProperty({ example: 'Jue', description: 'Día abreviado' })
  name!: string;
  @ApiProperty({ example: '2026-09-24', format: 'date' })
  date!: string;
  @ApiProperty({ example: 576300 })
  sales!: number;
}
