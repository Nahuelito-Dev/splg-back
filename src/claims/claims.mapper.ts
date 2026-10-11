import { Claim } from './entities/claim.entity';
import { MyClaimResponseDto } from './dto/my-claim-response.dto';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { OrderRecordMapper } from '../order/order-record.mapper';
import { UserMapper } from '../users/user.mapper';

export class ClaimMapper {
  /**
   * `photoUrl` es la URL firmada ya calculada (ver `ClaimsService.photoUrlFor`):
   * el mapper es síncrono y no conoce S3. Sin ella, sale la URL
   * externa que el reclamo traía de antes, si la tiene.
   */
  static toDto(claim: Claim, photoUrl?: string | null): ClaimResponseDto {
    const dto = new ClaimResponseDto();
    dto.claim_id = claim.claimId;
    dto.distributor_id = claim.distributorId;
    dto.order_id = claim.orderId;
    dto.customer_id = claim.customerId;
    dto.reason = claim.reason;
    dto.description = claim.description;
    dto.photoUrl = photoUrl ?? claim.photoUrl;
    dto.status = claim.status;
    dto.resolutionNote = claim.resolutionNote;
    dto.createdAt = claim.createdAt;
    if (claim.order) dto.order = OrderRecordMapper.toDto(claim.order);
    if (claim.customer) dto.customer = UserMapper.toDto(claim.customer);
    return dto;
  }

  /** Lo que ve el cliente de su propio reclamo: sin datos del chofer ni internos. */
  static toMyDto(claim: Claim, photoUrl?: string | null): MyClaimResponseDto {
    const dto = new MyClaimResponseDto();
    dto.claimId = claim.claimId;
    dto.status = claim.status;
    dto.reason = claim.reason;
    dto.description = claim.description;
    dto.createdAt = claim.createdAt;
    dto.order = {
      orderId: claim.order.orderId,
      status: claim.order.status,
      totalAmount: claim.order.totalAmount,
      createdAt: claim.order.createdAt,
      scheduledDate: claim.order.scheduledDate ?? null,
    };
    dto.photoUrl = photoUrl ?? claim.photoUrl;
    dto.resolutionNote = claim.resolutionNote;
    return dto;
  }
}
