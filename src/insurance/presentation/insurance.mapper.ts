import { diaArgentino } from '../../common/utils/dias-argentina';
import { estadoDeLaPoliza } from '../domain/insurance-rules';
import {
  CarInsuranceResponseDto,
  InsuranceInstallmentDetailDto,
  InsuranceInstallmentResponseDto,
  InsurancePolicyResponseDto,
} from '../dto/insurance-policy.dto';
import { InsurerResponseDto } from '../dto/insurer.dto';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { Insurer } from '../entities/insurer.entity';

export class InsuranceMapper {
  static insurer(i: Insurer): InsurerResponseDto {
    const dto = new InsurerResponseDto();
    dto.insurerId = i.insurerId;
    dto.name = i.name;
    dto.taxId = i.taxId;
    dto.phone = i.phone;
    dto.email = i.email;
    dto.website = i.website;
    dto.paymentUrl = i.paymentUrl;
    dto.notes = i.notes;
    dto.createdAt = i.createdAt;
    return dto;
  }

  static installment(c: InsuranceInstallment): InsuranceInstallmentResponseDto {
    const dto = new InsuranceInstallmentResponseDto();
    InsuranceMapper.llenarCuota(dto, c);
    return dto;
  }

  /** La cuota con su póliza, aseguradora y vehículo cargados. */
  static installmentDetail(
    c: InsuranceInstallment,
  ): InsuranceInstallmentDetailDto {
    const dto = new InsuranceInstallmentDetailDto();
    InsuranceMapper.llenarCuota(dto, c);
    dto.carId = c.policy?.carId ?? '';
    dto.carPatent = c.policy?.car?.carPatent ?? null;
    dto.policyNumber = c.policy?.policyNumber ?? '';
    dto.insurerId = c.policy?.insurerId ?? '';
    dto.insurerName = c.policy?.insurer?.name ?? '';
    dto.paymentUrl = c.policy?.insurer?.paymentUrl ?? null;
    return dto;
  }

  /** La póliza con su aseguradora y sus cuotas (por número) cargadas. */
  static policy(
    p: InsurancePolicy,
    hoy: string = diaArgentino(),
  ): InsurancePolicyResponseDto {
    const dto = new InsurancePolicyResponseDto();
    dto.policyId = p.policyId;
    dto.carId = p.carId;
    dto.carPatent = p.car?.carPatent ?? null;
    dto.insurer = p.insurer
      ? InsuranceMapper.insurer(p.insurer)
      : new InsurerResponseDto();
    dto.policyNumber = p.policyNumber;
    dto.coverage = p.coverage;
    dto.validFrom = p.validFrom;
    dto.validTo = p.validTo;
    dto.paymentCode = p.paymentCode;
    dto.status = estadoDeLaPoliza(p, hoy);
    dto.cancelledAt = p.cancelledAt;
    dto.cancelReason = p.cancelReason;
    dto.installments = [...(p.installments ?? [])]
      .sort((a, b) => a.number - b.number)
      .map((c) => InsuranceMapper.installment(c));
    dto.createdAt = p.createdAt;
    return dto;
  }

  /** La póliza que corresponde mostrar y el resto como historial. */
  static carInsurance(
    carId: string,
    current: InsurancePolicy | null,
    history: InsurancePolicy[],
  ): CarInsuranceResponseDto {
    const hoy = diaArgentino();
    const dto = new CarInsuranceResponseDto();
    dto.carId = carId;
    dto.current = current ? InsuranceMapper.policy(current, hoy) : null;
    dto.history = history.map((p) => InsuranceMapper.policy(p, hoy));
    return dto;
  }

  private static llenarCuota(
    dto: InsuranceInstallmentResponseDto,
    c: InsuranceInstallment,
  ): void {
    dto.installmentId = c.installmentId;
    dto.policyId = c.policyId;
    dto.number = c.number;
    dto.total = c.total;
    dto.label = `${c.number}/${c.total}`;
    dto.dueDate = c.dueDate;
    dto.graceUntil = c.graceUntil;
    dto.amount = c.amount;
    dto.status = c.status;
    dto.paidAt = c.paidAt;
    dto.paidAmount = c.paidAmount;
    dto.operationNumber = c.operationNumber;
    dto.paidByUserId = c.paidByUserId;
    dto.cashMovementId = c.cashMovementId;
    dto.receiptAttachmentId = c.receiptAttachmentId;
    dto.createdAt = c.createdAt;
  }
}
