import {
  Field,
  Float,
  GraphQLISODateTime,
  Int,
  ObjectType,
} from '@nestjs/graphql';
import { ApiProperty } from '@nestjs/swagger';

// Los informes de ventas también se consultan por GraphQL (`/api/graphql`): los
// mismos DTOs describen la respuesta REST (Swagger) y el tipo de GraphQL.

@ObjectType('SalesByDriverRow', { description: 'Ventas cobradas de un chofer' })
export class VentasPorChoferDto {
  @Field({ description: 'user_id del chofer' })
  @ApiProperty({ format: 'uuid', description: 'user_id del chofer' })
  driverId!: string;
  @Field(() => String, { nullable: true })
  @ApiProperty({ type: String, nullable: true })
  driverName!: string | undefined;
  @Field(() => Int) @ApiProperty() totalOrders!: number;
  @Field(() => Float) @ApiProperty() totalSales!: number;
}

@ObjectType('SalesByProductRow', {
  description: 'Unidades y ventas cobradas de un producto',
})
export class VentasPorProductoDto {
  @Field() @ApiProperty({ example: '10kg' }) productType!: string;
  @Field(() => String, { nullable: true })
  @ApiProperty({ type: String, nullable: true })
  description!: string | null;
  @Field(() => Int) @ApiProperty() totalQuantity!: number;
  @Field(() => Float) @ApiProperty() totalSales!: number;
}

@ObjectType('SalesByPaymentRow', {
  description: 'Ventas cobradas de un medio de pago',
})
export class VentasPorMedioDePagoDto {
  @Field({ description: 'Medio de pago (cash, transfer, mercadopago…)' })
  @ApiProperty({ example: 'cash' })
  method!: string;
  @Field(() => Int) @ApiProperty() totalOrders!: number;
  @Field(() => Float) @ApiProperty() totalSales!: number;
}

@ObjectType('SalesPeriod', { description: 'Ventas cobradas de un período' })
export class EvolucionDeVentasDto {
  @Field(() => GraphQLISODateTime, {
    description: 'Instante en que arranca el período (hora argentina)',
  })
  @ApiProperty({ type: String, format: 'date-time' })
  period!: Date;
  @Field(() => Int) @ApiProperty() totalOrders!: number;
  @Field(() => Float) @ApiProperty() totalSales!: number;
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
      'Sólo pedidos viejos: transferencias de pedidos entregados que quedaron sin confirmar (`paymentStatus: pending`). La confirmación ya no existe',
  })
  pendingTransfer!: CifraDeCobroDto;
  @ApiProperty({
    type: CifraDeCobroDto,
    description:
      'Sólo pedidos viejos: transferencias que un admin marcó como no recibidas (`paymentStatus: failed`)',
  })
  notReceivedTransfer!: CifraDeCobroDto;
  @ApiProperty({
    type: CifraDeCobroDto,
    description:
      'Pedidos COBRADOS (`paymentStatus: paid`: transferencia o MercadoPago) y luego CANCELADOS en el rango (por fecha de la última modificación): el dinero hay que devolverlo. Dato informativo, el sistema no gestiona el reintegro',
  })
  pendingRefund!: CifraDeCobroDto;
}
