import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RaterRole } from '../entities/rating.entity';
import { UserResponseDto } from '../../users/dto/user-response.dto';

export class RatingResponseDto {
  @ApiProperty({ format: 'uuid' }) rating_id!: string;
  @ApiProperty({ format: 'uuid' }) order_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ format: 'uuid', description: 'Quién califica' })
  from_user_id!: string;
  @ApiProperty({ format: 'uuid', description: 'Quién es calificado' })
  to_user_id!: string;
  @ApiProperty({ enum: RaterRole }) from_role!: RaterRole;
  @ApiProperty({ minimum: 1, maximum: 5 }) stars!: number;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({
    description:
      'Moderación: una calificación oculta no cuenta en promedios ni se ' +
      'muestra a clientes',
  })
  hidden!: boolean;
  @ApiProperty({ type: String, nullable: true }) hiddenReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  hiddenAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  hiddenByUserId!: string | null;
  @ApiPropertyOptional({ type: UserResponseDto })
  fromUser?: UserResponseDto;
}

/** Promedio y cantidad de calificaciones recibidas por un usuario. */
export class RatingSummaryDto {
  @ApiProperty({ example: 4.5 }) average!: number;
  @ApiProperty({ example: 12 }) count!: number;

  static de(average: number, count: number): RatingSummaryDto {
    const dto = new RatingSummaryDto();
    dto.average = average;
    dto.count = count;
    return dto;
  }
}
