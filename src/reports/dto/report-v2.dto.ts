import { Field, Float, Int, ObjectType } from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';
import {
  VentasPorChoferDto,
  VentasPorMedioDePagoDto,
  VentasPorProductoDto,
} from './report-response.dto';

/** Totales de un informe de ventas por pedidos: los calcula el back, el panel no suma filas. */
@ObjectType('SalesTotals', {
  description: 'Totales de todas las filas, calculados por el back',
})
export class TotalesDeVentasDto {
  @Field(() => Int, { description: 'Suma de pedidos de todas las filas' })
  @ApiProperty({ description: 'Suma de pedidos de todas las filas' })
  totalOrders!: number;
  @Field(() => Float, { description: 'Suma de ventas de todas las filas' })
  @ApiProperty({ description: 'Suma de ventas de todas las filas' })
  totalSales!: number;
}

@ObjectType('SalesByDriver')
export class VentasPorChoferV2Dto {
  @Field(() => [VentasPorChoferDto], { description: 'De mayor a menor venta' })
  @ApiProperty({
    type: VentasPorChoferDto,
    isArray: true,
    description: 'De mayor a menor venta',
  })
  rows!: VentasPorChoferDto[];
  @Field(() => TotalesDeVentasDto)
  @ApiProperty({ type: TotalesDeVentasDto })
  totals!: TotalesDeVentasDto;
}

@ObjectType('SalesByPayment')
export class VentasPorMedioDePagoV2Dto {
  @Field(() => [VentasPorMedioDePagoDto], {
    description: 'De mayor a menor venta',
  })
  @ApiProperty({
    type: VentasPorMedioDePagoDto,
    isArray: true,
    description: 'De mayor a menor venta',
  })
  rows!: VentasPorMedioDePagoDto[];
  @Field(() => TotalesDeVentasDto)
  @ApiProperty({ type: TotalesDeVentasDto })
  totals!: TotalesDeVentasDto;
}

@ObjectType('ProductSalesTotals', {
  description: 'Totales de todas las filas, calculados por el back',
})
export class TotalesPorProductoDto {
  @Field(() => Int, { description: 'Suma de unidades de todas las filas' })
  @ApiProperty({ description: 'Suma de unidades de todas las filas' })
  totalQuantity!: number;
  @Field(() => Float, { description: 'Suma de ventas de todas las filas' })
  @ApiProperty({ description: 'Suma de ventas de todas las filas' })
  totalSales!: number;
}

@ObjectType('SalesByProduct')
export class VentasPorProductoV2Dto {
  @Field(() => [VentasPorProductoDto], {
    description: 'De mayor a menor venta',
  })
  @ApiProperty({
    type: VentasPorProductoDto,
    isArray: true,
    description: 'De mayor a menor venta',
  })
  rows!: VentasPorProductoDto[];
  @Field(() => TotalesPorProductoDto)
  @ApiProperty({ type: TotalesPorProductoDto })
  totals!: TotalesPorProductoDto;
}

@ObjectType('SalesSummary', {
  description: 'Ventas cobradas, pedidos y ticket promedio de un período',
})
export class ResumenDeVentasDto {
  @Field(() => Float, { description: 'Ventas cobradas del período' })
  @ApiProperty({ description: 'Ventas cobradas del período' })
  totalSales!: number;
  @Field(() => Int, {
    description: 'Pedidos entregados y cobrados del período',
  })
  @ApiProperty({ description: 'Pedidos entregados y cobrados del período' })
  totalOrders!: number;
  @Field(() => Float, {
    description: 'Ventas / pedidos, a 2 decimales; 0 si no hubo pedidos',
  })
  @ApiProperty({
    description: 'Ventas / pedidos, a 2 decimales; 0 si no hubo pedidos',
  })
  averageTicket!: number;
}

@ObjectType('DayRange', {
  description: 'Días en hora argentina, ambos inclusive (YYYY-MM-DD)',
})
export class RangoDeDiasDto {
  @Field() @ApiProperty({ example: '2026-10-01' }) from!: string;
  @Field() @ApiProperty({ example: '2026-10-30' }) to!: string;
}

@ObjectType('SalesComparison', {
  description: 'Resumen del período y del inmediato anterior',
})
export class ComparativoDeVentasDto {
  @Field(() => ResumenDeVentasDto)
  @ApiProperty({ type: ResumenDeVentasDto })
  current!: ResumenDeVentasDto;
  @Field(() => ResumenDeVentasDto, {
    nullable: true,
    description:
      'El período inmediato anterior, de la misma cantidad de días; null con compare en false',
  })
  @ApiProperty({
    type: ResumenDeVentasDto,
    nullable: true,
    description:
      'El período inmediato anterior, de la misma cantidad de días; null con `compare=false`',
  })
  previous!: ResumenDeVentasDto | null;
  @Field(() => RangoDeDiasDto)
  @ApiProperty({ type: RangoDeDiasDto })
  currentRange!: RangoDeDiasDto;
  @Field(() => RangoDeDiasDto, { nullable: true })
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
