import { Car } from './entities/car.entity';
import { CarResponseDto } from './dto/car-response.dto';
import { UserMapper } from '../users/user.mapper';

export class CarMapper {
  static toDto(c: Car): CarResponseDto {
    const dto = new CarResponseDto();
    dto.car_id = c.car_id;
    dto.distributor_id = c.distributor_id;
    dto.user_id = c.user_id;
    dto.type_car = c.type_car;
    dto.car_capacity = c.car_capacity;
    dto.car_patent = c.car_patent;
    dto.car_brand = c.car_brand;
    dto.car_model = c.car_model;
    dto.car_year = c.car_year;
    dto.car_color = c.car_color;
    dto.createdAt = c.createdAt;
    dto.updatedAt = c.updatedAt;
    if (c.user) dto.user = UserMapper.toDto(c.user);
    return dto;
  }
}
