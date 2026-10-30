import Decimal from 'decimal.js';
import { latLngDesdePunto } from '../common/geo/punto';
import { Employee } from '../employee/entities/employee.entity';
import {
  FuelLoadV2ResponseDto,
  TireV2ResponseDto,
  VehicleAccidentV2ResponseDto,
} from './dto/fleet-expense-v2.dto';
import { FuelLoadResponseDto } from './dto/fuel-load.dto';
import { TrafficFineResponseDto } from './dto/traffic-fine.dto';
import { TrafficFineV2ResponseDto } from './dto/traffic-fine-v2.dto';
import {
  VehicleAccidentCreatedDto,
  VehicleAccidentResponseDto,
} from './dto/vehicle-accident.dto';
import { TireEventResponseDto, TireResponseDto } from './dto/tire.dto';
import { FuelLoad, FuelPaymentMethod } from './entities/fuel-load.entity';
import { TrafficFine } from './entities/traffic-fine.entity';
import { VehicleAccident } from './entities/vehicle-accident.entity';
import { Tire } from './entities/tire.entity';
import { TireEvent } from './entities/tire-event.entity';

function nombreDe(e: Employee | null | undefined): string | null {
  return e ? `${e.firstName} ${e.lastName}` : null;
}

export class FleetExpenseMapper {
  static fuelLoad(f: FuelLoad): FuelLoadResponseDto {
    const dto = new FuelLoadResponseDto();
    dto.fuelLoadId = f.fuelLoadId;
    dto.distributorId = f.distributorId;
    dto.carId = f.carId;
    dto.carPatent = f.car?.carPatent ?? null;
    dto.employeeId = f.employeeId;
    dto.employeeName = nombreDe(f.employee);
    dto.loadedAt = f.loadedAt;
    dto.fuelType = f.fuelType;
    dto.liters = f.liters;
    dto.unitPrice = f.unitPrice;
    dto.totalAmount = f.totalAmount;
    dto.odometerKm = f.odometerKm;
    dto.isFullTank = f.isFullTank;
    dto.station = f.station;
    dto.paymentMethod = f.paymentMethod;
    dto.receiptNumber = f.receiptNumber;
    dto.cashMovementId = f.cashMovementId;
    dto.registeredByDriver = f.registeredByDriver;
    dto.cashPaymentLegacy = f.cashPaymentLegacy;
    dto.anomaly = f.anomaly;
    dto.notes = f.notes;
    dto.odometerCorrectionNote = f.odometerCorrectionNote;
    dto.voidedAt = f.deletedAt;
    dto.createdAt = f.createdAt;
    return dto;
  }

  static trafficFine(m: TrafficFine): TrafficFineResponseDto {
    const dto = new TrafficFineResponseDto();
    dto.fineId = m.fineId;
    dto.distributorId = m.distributorId;
    dto.carId = m.carId;
    dto.carPatent = m.car?.carPatent ?? null;
    dto.employeeId = m.employeeId;
    dto.employeeName = nombreDe(m.employee);
    dto.occurredAt = m.occurredAt;
    dto.jurisdiction = m.jurisdiction;
    dto.actNumber = m.actNumber;
    dto.infraction = m.infraction;
    dto.amount = m.amount;
    dto.voluntaryPaymentAmount = m.voluntaryPaymentAmount;
    dto.dueDate = m.dueDate;
    dto.status = m.status;
    dto.paidAt = m.paidAt;
    dto.paidAmount = m.paidAmount;
    dto.cashMovementId = m.cashMovementId;
    dto.chargedToEmployee = m.chargedToEmployee;
    dto.voidReason = m.voidReason;
    dto.voidedAt = m.voidedAt;
    dto.createdAt = m.createdAt;
    return dto;
  }

  static trafficFineV2(m: TrafficFine): TrafficFineV2ResponseDto {
    const dto = Object.assign(
      new TrafficFineV2ResponseDto(),
      FleetExpenseMapper.trafficFine(m),
    );
    dto.paymentUrl = m.paymentUrl;
    dto.paymentCode = m.paymentCode;
    dto.operationNumber = m.operationNumber;
    dto.receiptAttachmentId = m.receiptAttachmentId;
    return dto;
  }

  static vehicleAccident(a: VehicleAccident): VehicleAccidentResponseDto {
    const dto = new VehicleAccidentResponseDto();
    dto.accidentId = a.accidentId;
    dto.distributorId = a.distributorId;
    dto.carId = a.carId;
    dto.carPatent = a.car?.carPatent ?? null;
    dto.employeeId = a.employeeId;
    dto.employeeName = nombreDe(a.employee);
    dto.occurredAt = a.occurredAt;
    dto.location = latLngDesdePunto(a.location);
    dto.address = a.address;
    dto.description = a.description;
    dto.injuries = a.injuries;
    dto.thirdPartiesInvolved = a.thirdPartiesInvolved;
    dto.hazmatRelease = a.hazmatRelease;
    dto.policeReportNumber = a.policeReportNumber;
    dto.insurerClaimNumber = a.insurerClaimNumber;
    dto.status = a.status;
    dto.vehicleUnusable = a.vehicleUnusable;
    dto.repairCost = a.repairCost;
    dto.insurerReimbursement = a.insurerReimbursement;
    dto.deductibleAmount = a.deductibleAmount;
    dto.netCost =
      a.repairCost === null
        ? null
        : new Decimal(a.repairCost)
            .minus(a.insurerReimbursement ?? 0)
            .toDecimalPlaces(2)
            .toNumber();
    dto.closedAt = a.closedAt;
    dto.createdAt = a.createdAt;
    return dto;
  }

  static siniestroRegistrado(r: {
    siniestro: VehicleAccident;
    assignmentKept: boolean;
    assignmentKeptReason: string | null;
  }): VehicleAccidentCreatedDto {
    const dto = new VehicleAccidentCreatedDto();
    Object.assign(dto, FleetExpenseMapper.vehicleAccident(r.siniestro));
    dto.assignmentKept = r.assignmentKept;
    dto.assignmentKeptReason = r.assignmentKeptReason;
    return dto;
  }

  static tireEvent(e: TireEvent): TireEventResponseDto {
    const dto = new TireEventResponseDto();
    dto.eventId = e.eventId;
    dto.tireId = e.tireId;
    dto.type = e.type;
    dto.carId = e.carId;
    dto.position = e.position;
    dto.odometerKm = e.odometerKm;
    dto.createdAt = e.createdAt;
    return dto;
  }

  static tire(t: Tire, events?: TireEvent[]): TireResponseDto {
    const dto = new TireResponseDto();
    dto.tireId = t.tireId;
    dto.distributorId = t.distributorId;
    dto.serialNumber = t.serialNumber;
    dto.brand = t.brand;
    dto.size = t.size;
    dto.cost = t.cost;
    dto.status = t.status;
    dto.carId = t.carId;
    dto.carPatent = t.car?.carPatent ?? null;
    dto.position = t.position;
    dto.mountedOdometerKm = t.mountedOdometerKm;
    dto.kmTraveled = t.kmTraveled;
    dto.retreadCount = t.retreadCount;
    dto.createdAt = t.createdAt;
    if (events) dto.events = events.map((e) => FleetExpenseMapper.tireEvent(e));
    return dto;
  }

  static tireV2(t: Tire, events?: TireEvent[]): TireV2ResponseDto {
    const dto = Object.assign(
      new TireV2ResponseDto(),
      FleetExpenseMapper.tire(t, events),
    );
    dto.cashMovementId = t.cashMovementId;
    dto.paidAt = t.paidAt;
    dto.isPaid = t.cashMovementId !== null;
    return dto;
  }

  static fuelLoadV2(f: FuelLoad): FuelLoadV2ResponseDto {
    const dto = Object.assign(
      new FuelLoadV2ResponseDto(),
      FleetExpenseMapper.fuelLoad(f),
    );
    dto.paidAt = f.paidAt;
    dto.isPaid = f.cashMovementId !== null;
    dto.isPayable =
      f.cashMovementId === null &&
      f.deletedAt === null &&
      !f.cashPaymentLegacy &&
      f.paymentMethod !== FuelPaymentMethod.DRIVER_CASH;
    return dto;
  }

  static vehicleAccidentV2(a: VehicleAccident): VehicleAccidentV2ResponseDto {
    const dto = Object.assign(
      new VehicleAccidentV2ResponseDto(),
      FleetExpenseMapper.vehicleAccident(a),
    );
    dto.paymentCashMovementId = a.paymentCashMovementId;
    dto.paymentPaidAt = a.paymentPaidAt;
    dto.paymentAmount = a.paymentAmount;
    dto.isPaid = a.paymentCashMovementId !== null;
    dto.reimbursementCashMovementId = a.reimbursementCashMovementId;
    dto.reimbursementReceivedAt = a.reimbursementReceivedAt;
    dto.reimbursementAmount = a.reimbursementAmount;
    dto.isReimbursed = a.reimbursementCashMovementId !== null;
    return dto;
  }
}
