import { ApiProperty } from '@nestjs/swagger';

export class VentasPorChoferDto {
  @ApiProperty({ format: 'uuid', description: 'user_id del chofer' })
  driverId!: string;
  @ApiProperty({ type: String, nullable: true }) driverName!:
    | string
    | undefined;
  @ApiProperty() totalOrders!: number;
  @ApiProperty() totalSales!: number;
}

export class VentasPorProductoDto {
  @ApiProperty({ example: '10kg' }) productType!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty() totalSales!: number;
}

export class VentasPorMedioDePagoDto {
  @ApiProperty({ example: 'cash' }) method!: string;
  @ApiProperty() totalOrders!: number;
  @ApiProperty() totalSales!: number;
}

export class EvolucionDeVentasDto {
  @ApiProperty({ type: String, format: 'date-time' }) period!: Date;
  @ApiProperty() totalOrders!: number;
  @ApiProperty() totalSales!: number;
}

export class CifraDeCobroDto {
  @ApiProperty({ description: 'Pedidos entregados en el rango' })
  totalOrders!: number;
  @ApiProperty({ description: 'Suma del total de esos pedidos' })
  totalAmount!: number;
}

/** Cobros que no suman a las ventas: efectivo sin confirmar, impagos, pérdidas y transferencias sin confirmar. */
export class CobrosDeEfectivoDto {
  @ApiProperty({
    type: CifraDeCobroDto,
    description:
      'Efectivo entregado que el chofer todavía no confirmó como cobrado (`paymentStatus: pending`)',
  })
  pendingCash!: CifraDeCobroDto;
  @ApiProperty({
    type: CifraDeCobroDto,
    description:
      'Efectivo que el chofer informó como impago (`unpaid`), sin resolver',
  })
  unpaid!: CifraDeCobroDto;
  @ApiProperty({
    type: CifraDeCobroDto,
    description: 'Impagos que un admin dio por perdidos (`written_off`)',
  })
  writtenOff!: CifraDeCobroDto;
  @ApiProperty({
    type: CifraDeCobroDto,
    description:
      'Transferencias de pedidos entregados que un admin todavía no confirmó (`paymentStatus: pending`). Se confirman con `PATCH /orders/{id}/payment/confirm-transfer`',
  })
  pendingTransfer!: CifraDeCobroDto;
  @ApiProperty({
    type: CifraDeCobroDto,
    description:
      'Transferencias que un admin marcó como no recibidas (`paymentStatus: failed`). Sólo se marcan sobre pedidos entregados; si el dinero llega después, `confirm-transfer` con `received: true` lo corrige',
  })
  notReceivedTransfer!: CifraDeCobroDto;
  @ApiProperty({
    type: CifraDeCobroDto,
    description:
      'Pedidos COBRADOS (`paymentStatus: paid`: transferencia o MercadoPago) y luego CANCELADOS en el rango (por fecha de la última modificación): el dinero hay que devolverlo. Dato informativo, el sistema no gestiona el reintegro',
  })
  pendingRefund!: CifraDeCobroDto;
}
