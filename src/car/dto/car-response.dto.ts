import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

export class CarResponseDto {
  @ApiProperty({ format: 'uuid' }) car_id!: string;
  @ApiProperty({ format: 'uuid' }) distributor_id!: string;
  @ApiProperty({ format: 'uuid', description: 'Chofer que lo conduce' })
  user_id!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Moto' })
  type_car!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Kilos' })
  car_capacity!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'AB104EJ' })
  car_patent!: string | null;
  @ApiProperty({ type: String, nullable: true }) car_brand!: string | null;
  @ApiProperty({ type: String, nullable: true }) car_model!: string | null;
  @ApiProperty({ type: Number, nullable: true }) car_year!: number | null;
  @ApiProperty({ type: String, nullable: true }) car_color!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
  @ApiPropertyOptional({ type: UserResponseDto }) user?: UserResponseDto;
}

export class CarBorradoResponseDto {
  @ApiProperty({ example: 'Car deleted successfully' }) message!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
}
