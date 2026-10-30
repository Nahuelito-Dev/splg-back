import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsNumber, IsPositive, IsUUID, Max } from 'class-validator';
import { PayFromCashBoxDto } from '../../cash/dto/pay-expense.dto';
import { FuelLoadResponseDto } from './fuel-load.dto';
import { TireResponseDto } from './tire.dto';
import { VehicleAccidentResponseDto } from './vehicle-accident.dto';

const IMPORTE_MAXIMO = 9_999_999_999.99;

/** El neumático con el estado de pago de su compra (API v2). */
export class TireV2ResponseDto extends TireResponseDto {
  @ApiProperty({ description: 'Si la compra ya salió de una caja' })
  isPaid!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  cashMovementId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt!: Date | null;
}

export class TireV2PageDto {
  @ApiProperty({ type: TireV2ResponseDto, isArray: true })
  data!: TireV2ResponseDto[];
  @ApiProperty({ example: 8 }) total!: number;
}

/** La carga con el estado de pago (API v2). */
export class FuelLoadV2ResponseDto extends FuelLoadResponseDto {
  @ApiProperty({ description: 'Si la carga ya salió de una caja' })
  isPaid!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt!: Date | null;
  @ApiProperty({
    description:
      'Si se puede pagar desde una caja con `POST /fleet/fuel-loads/:id/pay` (no está paga ni anulada, no la pagó el chofer con su efectivo ni es anterior al asiento de caja)',
  })
  isPayable!: boolean;
}

export class FuelLoadV2PageDto {
  @ApiProperty({ type: FuelLoadV2ResponseDto, isArray: true })
  data!: FuelLoadV2ResponseDto[];
  @ApiProperty({ example: 12 }) total!: number;
  @ApiProperty({ example: 530.25 }) totalLiters!: number;
  @ApiProperty({ example: 556762.5 }) totalAmount!: number;
}

/** El siniestro con el pago de la empresa y el reintegro del seguro (API v2). */
export class VehicleAccidentV2ResponseDto extends VehicleAccidentResponseDto {
  @ApiProperty({ description: 'Si ya se registró lo que pagó la empresa' })
  isPaid!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  paymentCashMovementId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paymentPaidAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  paymentAmount!: number | null;
  @ApiProperty({ description: 'Si ya se registró el reintegro del seguro' })
  isReimbursed!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reimbursementCashMovementId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reimbursementReceivedAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true })
  reimbursementAmount!: number | null;
}

export class VehicleAccidentV2PageDto {
  @ApiProperty({ type: VehicleAccidentV2ResponseDto, isArray: true })
  data!: VehicleAccidentV2ResponseDto[];
  @ApiProperty({ example: 3 }) total!: number;
}

/** Lo que pagó la empresa por el siniestro (reparación o franquicia). */
export class PayAccidentDto extends PayFromCashBoxDto {
  @ApiProperty({
    example: 85000,
    description:
      'Importe pagado. Con el siniestro cerrado no puede superar el costo de la reparación (o la franquicia, si es mayor)',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(IMPORTE_MAXIMO)
  amount!: number;
}

/** El reintegro que pagó el seguro, como ingreso de una caja. */
export class ReceiveReimbursementDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Caja en la que entra el dinero: efectivo, banco o billetera de la distribuidora',
  })
  @IsUUID()
  cashBoxId!: string;

  @ApiProperty({
    type: String,
    example: '2026-10-28T14:30:00-03:00',
    description:
      'Cuándo se recibió (fecha o fecha y hora ISO 8601); no puede ser futura ni anterior al siniestro',
  })
  @IsISO8601({ strict: true })
  receivedAt!: string;

  @ApiProperty({
    example: 60000,
    description:
      'Importe recibido. Con el siniestro cerrado no puede superar el reintegro cargado al cerrar',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(IMPORTE_MAXIMO)
  amount!: number;
}
