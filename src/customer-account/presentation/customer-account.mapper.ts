import { AsientoAsentado } from '../application/customer-ledger.service';
import { signoDelAsiento } from '../domain/customer-account-rules';
import { CustomerEntryResponseDto } from '../dto/customer-account.dto';

export class CustomerAccountMapper {
  static asiento(
    a: AsientoAsentado,
    ocultarSaldo = false,
  ): CustomerEntryResponseDto {
    const e = a.entry;
    const dto = new CustomerEntryResponseDto();
    dto.entryId = e.entryId;
    dto.type = e.type;
    dto.amount = e.amount;
    dto.signedAmount = e.amount * signoDelAsiento(e.type);
    dto.balanceAfter = ocultarSaldo ? null : a.balanceAfter;
    dto.orderId = e.orderId;
    dto.dueDate = e.dueDate;
    dto.paymentMethod = e.paymentMethod;
    dto.cashMovementId = e.cashMovementId;
    dto.collectedByDeliveryId = e.collectedByDeliveryId;
    dto.description = e.description;
    dto.pendingAmount = a.pendingAmount;
    dto.occurredAt = e.occurredAt;
    dto.createdByUserId = e.createdByUserId;
    return dto;
  }
}
