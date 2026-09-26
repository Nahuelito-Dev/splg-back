import { ApiProperty } from '@nestjs/swagger';

export class RoleResponseDto {
  @ApiProperty({ format: 'uuid' })
  role_id!: string;

  @ApiProperty({ example: 'customer' })
  type!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  createdAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: Date | null;
}
