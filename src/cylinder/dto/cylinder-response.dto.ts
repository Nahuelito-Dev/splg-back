import { ApiProperty } from '@nestjs/swagger';
import { CylinderState } from '../entities/cylinder.entity';

/** El producto del catálogo al que pertenece el envase. */
export class ProductoDelEnvaseDto {
  @ApiProperty({ example: 'Garrafa 10kg' }) type!: string;
  @ApiProperty({ example: 10 }) weight!: number;
}

/** El cliente que tiene el envase en su poder. */
export class ClienteDelEnvaseDto {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({ type: String, nullable: true }) full_name!: string | null;
  @ApiProperty({ type: String, nullable: true }) phone_number!: string | null;
}

export class CylinderResponseDto {
  @ApiProperty({ format: 'uuid' }) cylinder_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ example: 'SN-000123' }) serial!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Tipo de garrafa',
  })
  gas_cylinder_id!: string | null;
  @ApiProperty({ enum: CylinderState }) state!: CylinderState;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Cliente que lo tiene',
  })
  current_customer_id!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  current_order_id!: string | null;
  @ApiProperty({ example: 15000 }) deposit!: number;
  @ApiProperty({
    type: ProductoDelEnvaseDto,
    nullable: true,
    description: 'Tipo y peso del producto (null si no tiene uno asignado)',
  })
  gas_cylinder!: ProductoDelEnvaseDto | null;
  @ApiProperty({
    type: ClienteDelEnvaseDto,
    nullable: true,
    description: 'Quién lo tiene ahora (null si está en la distribuidora)',
  })
  current_customer!: ClienteDelEnvaseDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  manufactured_at!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  last_inspection_at!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expires_at!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Fecha del último movimiento del envase. Sólo lo completa el listado ' +
      '(GET /cylinders); en el resto de las lecturas es null.',
  })
  lastMovementAt!: Date | null;
}

/** Un movimiento del envase: registro de sólo escritura. */
export class CylinderMovementResponseDto {
  @ApiProperty({ format: 'uuid' }) movement_id!: string;
  @ApiProperty({ format: 'uuid' }) cylinder_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ enum: CylinderState, nullable: true })
  from_state!: CylinderState | null;
  @ApiProperty({ enum: CylinderState }) to_state!: CylinderState;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  order_id!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actor_user_id!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}
