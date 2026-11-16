import { PaymentRefund } from './entities/payment-refund.entity';
import { RefundResponseDto } from './dto/refund-response.dto';

export class RefundMapper {
  static toDto(r: PaymentRefund): RefundResponseDto {
    const dto = new RefundResponseDto();
    dto.refundId = r.refundId;
    dto.orderId = r.orderId;
    dto.paymentId = r.paymentId;
    dto.kind = r.kind;
    dto.amount = r.amount;
    dto.status = r.status;
    dto.gatewayRefundId = r.gatewayRefundId;
    dto.errorMessage = r.errorMessage;
    dto.attempts = r.attempts;
    dto.refundedAt = r.refundedAt;
    dto.createdAt = r.createdAt;
    dto.updatedAt = r.updatedAt;
    return dto;
  }
}
