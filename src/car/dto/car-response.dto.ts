import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FleetStatus, FuelType } from '../entities/car.entity';
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
  @ApiProperty({ enum: FuelType, nullable: true }) fuel_type!: FuelType | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Litros' })
  tank_capacity_liters!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Kilometraje vigente: el mayor entre las cargas de combustible y los cierres de mantenimiento',
  })
  odometer_km!: number | null;
  @ApiProperty({
    enum: FleetStatus,
    description: '`grounded` es fuera de servicio (se vuelve con CU-247)',
  })
  fleet_status!: FleetStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de la foto del vehículo (se abre sin token, vence); `null` si no tiene.',
  })
  photoUrl!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
  @ApiPropertyOptional({ type: UserResponseDto }) user?: UserResponseDto;
}

export class CarBorradoResponseDto {
  @ApiProperty({ example: 'Vehículo dado de baja' }) message!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
}
