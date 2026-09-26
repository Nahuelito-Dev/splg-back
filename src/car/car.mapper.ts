import { Car } from './entities/car.entity';
import { CarResponseDto } from './dto/car-response.dto';
import { UserMapper } from '../users/user.mapper';

export class CarMapper {
  static toDto(c: Car): CarResponseDto {
    const dto = new CarResponseDto();
    dto.car_id = c.carId;
    dto.distributor_id = c.distributorId;
    dto.user_id = c.userId;
    dto.type_car = c.typeCar;
    dto.car_capacity = c.carCapacity;
    dto.car_patent = c.carPatent;
    dto.car_brand = c.carBrand;
    dto.car_model = c.carModel;
    dto.car_year = c.carYear;
    dto.car_color = c.carColor;
    dto.createdAt = c.createdAt;
    dto.updatedAt = c.updatedAt;
    if (c.user) dto.user = UserMapper.toDto(c.user);
    return dto;
  }
}
