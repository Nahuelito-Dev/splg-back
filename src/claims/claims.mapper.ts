import { Claim } from './entities/claim.entity';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { OrderRecordMapper } from '../order/order-record.mapper';
import { UserMapper } from '../users/user.mapper';

export class ClaimMapper {
  static toDto(claim: Claim): ClaimResponseDto {
    const dto = new ClaimResponseDto();
    dto.claim_id = claim.claimId;
    dto.distributor_id = claim.distributorId;
    dto.order_id = claim.orderId;
    dto.customer_id = claim.customerId;
    dto.reason = claim.reason;
    dto.description = claim.description;
    dto.photoUrl = claim.photoUrl;
    dto.status = claim.status;
    dto.resolutionNote = claim.resolutionNote;
    dto.createdAt = claim.createdAt;
    if (claim.order) dto.order = OrderRecordMapper.toDto(claim.order);
    if (claim.customer) dto.customer = UserMapper.toDto(claim.customer);
    return dto;
  }
}
