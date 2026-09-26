import { Rating } from './entities/rating.entity';
import { RatingResponseDto } from './dto/rating-response.dto';
import { UserMapper } from '../users/user.mapper';

export class RatingMapper {
  static toDto(r: Rating): RatingResponseDto {
    const dto = new RatingResponseDto();
    dto.rating_id = r.rating_id;
    dto.order_id = r.order_id;
    dto.distributor_id = r.distributor_id;
    dto.from_user_id = r.from_user_id;
    dto.to_user_id = r.to_user_id;
    dto.from_role = r.from_role;
    dto.stars = r.stars;
    dto.comment = r.comment;
    dto.createdAt = r.createdAt;
    if (r.fromUser) dto.fromUser = UserMapper.toDto(r.fromUser);
    return dto;
  }
}
