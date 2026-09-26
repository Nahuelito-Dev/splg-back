import { Rating } from './entities/rating.entity';
import { RatingResponseDto } from './dto/rating-response.dto';
import { UserMapper } from '../users/user.mapper';

export class RatingMapper {
  static toDto(r: Rating): RatingResponseDto {
    const dto = new RatingResponseDto();
    dto.rating_id = r.ratingId;
    dto.order_id = r.orderId;
    dto.distributor_id = r.distributorId;
    dto.from_user_id = r.fromUserId;
    dto.to_user_id = r.toUserId;
    dto.from_role = r.fromRole;
    dto.stars = r.stars;
    dto.comment = r.comment;
    dto.createdAt = r.createdAt;
    if (r.fromUser) dto.fromUser = UserMapper.toDto(r.fromUser);
    return dto;
  }
}
