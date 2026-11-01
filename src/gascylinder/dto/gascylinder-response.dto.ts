import { ApiProperty } from '@nestjs/swagger';
import { PromocionConPrecioDto } from './create-gascylinder.dto';

/** Un producto del catálogo. */
export class GasCylinderResponseDto {
  @ApiProperty({ format: 'uuid' })
  gas_cylinder_id!: string;

  @ApiProperty({ format: 'uuid' })
  distributor_id!: string;

  @ApiProperty({ example: '10kg' })
  type!: string;

  @ApiProperty()
  weight!: number;

  @ApiProperty()
  price!: number;

  @ApiProperty()
  stock!: number;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de la imagen del producto (se abre sin token, vence); `null` si no tiene.',
  })
  photoUrl!: string | null;

  @ApiProperty({ type: PromocionConPrecioDto, isArray: true, nullable: true })
  promotions!: PromocionConPrecioDto[] | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

/** Una página del catálogo. */
export class CatalogoDto {
  @ApiProperty({ type: GasCylinderResponseDto, isArray: true })
  gasCylinders!: GasCylinderResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}

/** Un medio de pago que ofrece el catálogo, con su recargo en porcentaje. */
export class MedioDePagoDto {
  @ApiProperty({ example: 'Efectivo' })
  name!: string;

  @ApiProperty({ example: 'CASH', enum: ['CASH', 'TRANSFER', 'MERCADOPAGO'] })
  key!: string;

  @ApiProperty({
    example: 0,
    description:
      'Recargo en % que la distribuidora cobra con ese medio de pago (parámetro configurable; el monto exacto lo da `POST /orders/quote`)',
  })
  surcharge!: number;
}

/** Lo que se puede pedir ahora: productos con stock y medios de pago. */
export class DisponiblesDto {
  @ApiProperty({ type: GasCylinderResponseDto, isArray: true })
  products!: GasCylinderResponseDto[];

  @ApiProperty({ type: MedioDePagoDto, isArray: true })
  paymentMethods!: MedioDePagoDto[];
}

/** La baja de un producto: se desactiva, no se borra. */
export class BajaDeProductoDto {
  @ApiProperty({ example: 'Gas cylinder deactivated successfully' })
  message!: string;

  @ApiProperty({ format: 'uuid' })
  gasCylinderId!: string;
}
