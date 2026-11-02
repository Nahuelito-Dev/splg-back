import { ApiProperty } from '@nestjs/swagger';
import {
  VentasPorChoferDto,
  VentasPorMedioDePagoDto,
  VentasPorProductoDto,
} from './report-response.dto';

/** Totales de un informe de ventas por pedidos: los calcula el back, el panel no suma filas. */
export class TotalesDeVentasDto {
  @ApiProperty({ description: 'Suma de pedidos de todas las filas' })
  totalOrders!: number;
  @ApiProperty({ description: 'Suma de ventas de todas las filas' })
  totalSales!: number;
}

export class VentasPorChoferV2Dto {
  @ApiProperty({
    type: VentasPorChoferDto,
    isArray: true,
    description: 'De mayor a menor venta',
  })
  rows!: VentasPorChoferDto[];
  @ApiProperty({ type: TotalesDeVentasDto }) totals!: TotalesDeVentasDto;
}

export class VentasPorMedioDePagoV2Dto {
  @ApiProperty({
    type: VentasPorMedioDePagoDto,
    isArray: true,
    description: 'De mayor a menor venta',
  })
  rows!: VentasPorMedioDePagoDto[];
  @ApiProperty({ type: TotalesDeVentasDto }) totals!: TotalesDeVentasDto;
}

export class TotalesPorProductoDto {
  @ApiProperty({ description: 'Suma de unidades de todas las filas' })
  totalQuantity!: number;
  @ApiProperty({ description: 'Suma de ventas de todas las filas' })
  totalSales!: number;
}

export class VentasPorProductoV2Dto {
  @ApiProperty({
    type: VentasPorProductoDto,
    isArray: true,
    description: 'De mayor a menor venta',
  })
  rows!: VentasPorProductoDto[];
  @ApiProperty({ type: TotalesPorProductoDto })
  totals!: TotalesPorProductoDto;
}

export class ResumenDeVentasDto {
  @ApiProperty({ description: 'Ventas cobradas del período' })
  totalSales!: number;
  @ApiProperty({ description: 'Pedidos entregados y cobrados del período' })
  totalOrders!: number;
  @ApiProperty({
    description: 'Ventas / pedidos, a 2 decimales; 0 si no hubo pedidos',
  })
  averageTicket!: number;
}

export class RangoDeDiasDto {
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-30' }) to!: string;
}

export class ComparativoDeVentasDto {
  @ApiProperty({ type: ResumenDeVentasDto }) current!: ResumenDeVentasDto;
  @ApiProperty({
    type: ResumenDeVentasDto,
    nullable: true,
    description:
      'El período inmediato anterior, de la misma cantidad de días; null con `compare=false`',
  })
  previous!: ResumenDeVentasDto | null;
  @ApiProperty({ type: RangoDeDiasDto }) currentRange!: RangoDeDiasDto;
  @ApiProperty({ type: RangoDeDiasDto, nullable: true })
  previousRange!: RangoDeDiasDto | null;
}

export class TotalDelDiaDto {
  @ApiProperty({ example: '2026-10-30', description: 'Día en hora argentina' })
  day!: string;
  @ApiProperty({ description: 'Pedidos entregados ese día' })
  deliveredOrders!: number;
  @ApiProperty({
    description:
      'Lo que había que cobrar de esos pedidos: el total menos la seña ya paga',
  })
  totalAmount!: number;
}

export class ImpagosDto {
  @ApiProperty({ description: 'Pedidos con el cobro impago' })
  totalOrders!: number;
  @ApiProperty({ description: 'Suma del total de esos pedidos' })
  totalAmount!: number;
}
