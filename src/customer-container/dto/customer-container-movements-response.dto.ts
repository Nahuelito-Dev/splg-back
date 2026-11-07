import { ApiProperty } from '@nestjs/swagger';
import { CustomerContainerMovementReason } from '../entities/customer-container-movement.entity';

export class CustomerContainerMovementResponseDto {
  @ApiProperty({ format: 'uuid' })
  movementId!: string;
  @ApiProperty({ format: 'uuid' })
  gasCylinderId!: string;
  @ApiProperty()
  type!: string;
  @ApiProperty()
  quantity!: number;
  @ApiProperty({ enum: CustomerContainerMovementReason })
  reason!: CustomerContainerMovementReason;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  orderId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  note!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorUserId!: string | null;
  @ApiProperty()
  createdAt!: Date;
}

export class CustomerContainerMovementsResponseDto {
  @ApiProperty({ type: CustomerContainerMovementResponseDto, isArray: true })
  items!: CustomerContainerMovementResponseDto[];
  @ApiProperty()
  total!: number;
  @ApiProperty()
  limit!: number;
  @ApiProperty()
  offset!: number;
}
