import { ApiProperty } from '@nestjs/swagger';
import { DistributorStatus } from '../entities/distributor.entity';

export class DistributorResponseDto {
  @ApiProperty({ format: 'uuid' })
  distributor_id!: string;

  @ApiProperty({ example: 'Jeny Gas' })
  name!: string;

  @ApiProperty({ example: 'jeny-gas' })
  slug!: string;

  @ApiProperty({ type: String, nullable: true })
  legal_name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  tax_id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logo_url!: string | null;

  @ApiProperty({ enum: DistributorStatus })
  status!: DistributorStatus;

  @ApiProperty({ type: String, nullable: true })
  plan!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: Date | null;
}
