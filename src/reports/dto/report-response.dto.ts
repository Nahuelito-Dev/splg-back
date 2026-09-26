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
