import { ApiProperty } from '@nestjs/swagger';
import { CylinderState } from '../entities/cylinder.entity';

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
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
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
