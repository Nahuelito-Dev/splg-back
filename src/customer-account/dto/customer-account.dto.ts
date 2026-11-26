import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { CashMethod } from '../../cash/domain/cash.enums';
import { RechazarTransferenciaEnDto } from '../../order/domain/medio-de-pago-aceptado';
import { Importe } from '../../common/decorators/importe.decorator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { esCuitValido, normalizarCuit } from '../../purchase/domain/cuit';
import {
  AdjustmentKind,
  CustomerAccountStatus,
  CustomerEntryType,
  TaxCondition,
} from '../domain/customer-account.enums';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

const aCuit = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizarCuit(value.trim()) : value;

/** CUIT con prefijo y dígito verificador válidos (acepta guiones y espacios). */
function EsCuit(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'esCuit',
      target: target.constructor,
      propertyName: String(propertyKey),
      options: {
        message:
          'taxId: no es un CUIT válido (11 dígitos y dígito verificador)',
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && esCuitValido(value),
      },
    });
}

export class CreateCustomerAccountDto {
  @ApiProperty({ description: 'Usuario del cliente (`user_id`)' })
  @IsUUID()
  customerUserId!: string;

  @ApiProperty({ example: 'Panadería La Espiga S.R.L.', maxLength: 120 })
  @TextoNoVacio()
  @MaxLength(120)
  businessName!: string;

  @ApiPropertyOptional({
    example: '30715123456',
    description:
      'CUIT de 11 dígitos con su dígito verificador (acepta guiones)',
  })
  @IsOptional()
  @Transform(aCuit)
  @EsCuit()
  taxId?: string;

  @ApiProperty({ enum: TaxCondition, example: TaxCondition.REGISTERED })
  @IsEnum(TaxCondition)
  taxCondition!: TaxCondition;

  @ApiProperty({ example: 150000, description: 'Límite de crédito, 0 o más' })
  @Importe(0)
  creditLimit!: number;

  @ApiProperty({
    example: 30,
    description: 'Plazo de pago en días, entero positivo',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  paymentTermsDays!: number;
}

export class UpdateCustomerAccountDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(120)
  businessName?: string;

  @ApiPropertyOptional({ example: '30715123456' })
  @IsOptional()
  @Transform(aCuit)
  @EsCuit()
  taxId?: string;

  @ApiPropertyOptional({ enum: TaxCondition })
  @IsOptional()
  @IsEnum(TaxCondition)
  taxCondition?: TaxCondition;

  @ApiPropertyOptional({ example: 200000 })
  @IsOptional()
  @Importe(0)
  creditLimit?: number;

  @ApiPropertyOptional({ example: 45 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  paymentTermsDays?: number;

  @ApiPropertyOptional({
    enum: CustomerAccountStatus,
    description:
      'Bloquear impide vender a cuenta; cerrar exige saldo cero y sin pedidos a cuenta abiertos',
  })
  @IsOptional()
  @IsEnum(CustomerAccountStatus)
  status?: CustomerAccountStatus;
}

export class QueryCustomerAccountDto extends PaginationDto {
  @ApiPropertyOptional({ enum: CustomerAccountStatus })
  @IsOptional()
  @IsEnum(CustomerAccountStatus)
  status?: CustomerAccountStatus;

  @ApiPropertyOptional({ description: 'Sólo las que tienen deuda vencida' })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({
    description: 'Razón social, CUIT, nombre o correo del cliente',
  })
  @IsOptional()
  @IsString()
  q?: string;
}

export class QueryCustomerEntryDto extends PaginationDto {
  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class RegisterPaymentDto {
  @ApiProperty({ example: 35000 })
  @Importe()
  amount!: number;

  @ApiProperty({
    description:
      'Medio con que paga el cliente. La transferencia ya no se acepta: 400 `PAYMENT_METHOD_NOT_ACCEPTED`',
    enum: Object.values(CashMethod).filter((m) => m !== CashMethod.TRANSFER),
    example: CashMethod.CASH,
  })
  @RechazarTransferenciaEnDto()
  @IsEnum(CashMethod)
  method!: CashMethod;

  @ApiPropertyOptional({
    description:
      'Caja donde entra el dinero. Obligatoria para el administrador; el chofer NO la manda (el dinero entra a su rendición).',
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;

  @ApiPropertyOptional({
    example: 'Pago de las facturas de octubre',
    maxLength: 255,
  })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(255)
  description?: string;
}

export class RegisterAdjustmentDto {
  @ApiProperty({
    enum: AdjustmentKind,
    description:
      '`credit` baja la deuda (nota de crédito); `debit` la sube (nota de débito)',
  })
  @IsEnum(AdjustmentKind)
  kind!: AdjustmentKind;

  @ApiProperty({ example: 1200 })
  @Importe()
  amount!: number;

  @ApiProperty({ example: 'Garrafa devuelta en mal estado', maxLength: 255 })
  @TextoNoVacio()
  @MaxLength(255)
  reason!: string;
}

export class AgingBucketsDto {
  @ApiProperty({
    example: 12000,
    description: '0 a 30 días desde el comprobante',
  })
  upTo30Days!: number;
  @ApiProperty({ example: 8000 }) from31To60Days!: number;
  @ApiProperty({ example: 0 }) from61To90Days!: number;
  @ApiProperty({ example: 0, description: 'Más de 90 días' })
  over90Days!: number;
  @ApiProperty({ example: 20000 }) total!: number;
}

export class CustomerAccountResponseDto {
  @ApiProperty() accountId!: string;
  @ApiProperty() customerUserId!: string;
  @ApiProperty({ example: 'Ana Gómez' }) customerName!: string;
  @ApiProperty({ type: String, nullable: true }) customerEmail!: string | null;
  @ApiProperty({ example: 'Panadería La Espiga S.R.L.' }) businessName!: string;
  @ApiProperty({ type: String, nullable: true }) taxId!: string | null;
  @ApiProperty({ enum: TaxCondition }) taxCondition!: TaxCondition;
  @ApiProperty({ example: 150000 }) creditLimit!: number;
  @ApiProperty({ example: 30 }) paymentTermsDays!: number;
  @ApiProperty({ enum: CustomerAccountStatus }) status!: CustomerAccountStatus;
  @ApiProperty({ example: 42000, description: 'Positivo: el cliente debe' })
  balance!: number;
  @ApiProperty({
    example: 8000,
    description:
      'Pedidos a cuenta todavía no entregados (su cargo aún no está en el saldo)',
  })
  pendingOrdersAmount!: number;
  @ApiProperty({
    example: 100000,
    description:
      'Límite − saldo − pedidos a cuenta abiertos. Puede ser negativo.',
  })
  availableCredit!: number;
  @ApiProperty({
    example: 12000,
    description: 'Deuda con vencimiento anterior a hoy',
  })
  overdueAmount!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CustomerAccountDetailDto extends CustomerAccountResponseDto {
  @ApiProperty({ type: AgingBucketsDto }) aging!: AgingBucketsDto;
}

export class CustomerAccountPageDto {
  @ApiProperty({ type: [CustomerAccountResponseDto] })
  data!: CustomerAccountResponseDto[];
  @ApiProperty({ example: 14 }) total!: number;
}

export class CustomerEntryResponseDto {
  @ApiProperty() entryId!: string;
  @ApiProperty({ enum: CustomerEntryType }) type!: CustomerEntryType;
  @ApiProperty({
    example: 35000,
    description: 'Siempre positivo; el signo lo da el tipo',
  })
  amount!: number;
  @ApiProperty({
    example: -35000,
    description: 'Con signo: positivo suma deuda',
  })
  signedAmount!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 42000,
    description:
      'Saldo de la cuenta después de este asiento. `null` cuando lo registra un chofer: la deuda de un cliente no es suya para ver',
  })
  balanceAfter!: number | null;
  @ApiProperty({ type: String, nullable: true }) orderId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-15' })
  dueDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) paymentMethod!: string | null;
  @ApiProperty({ type: String, nullable: true }) cashMovementId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Chofer que cobró en la calle',
  })
  collectedByDeliveryId!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({
    example: 5000,
    description:
      'En un cargo o nota de débito: lo que todavía no se saldó con pagos',
  })
  pendingAmount!: number;
  @ApiProperty() occurredAt!: Date;
  @ApiProperty({ type: String, nullable: true }) createdByUserId!:
    | string
    | null;
}

export class CustomerStatementDto {
  @ApiProperty({ example: 10000, description: 'Saldo antes del período' })
  openingBalance!: number;
  @ApiProperty({ example: 42000, description: 'Saldo al final del período' })
  closingBalance!: number;
  @ApiProperty({ type: [CustomerEntryResponseDto] })
  data!: CustomerEntryResponseDto[];
  @ApiProperty({ example: 18, description: 'Asientos del período' })
  total!: number;
}

export class AgingAccountRowDto extends AgingBucketsDto {
  @ApiProperty() accountId!: string;
  @ApiProperty({ example: 'Panadería La Espiga S.R.L.' }) businessName!: string;
}

export class AgingReportDto {
  @ApiProperty({
    type: AgingBucketsDto,
    description: 'Totales de toda la distribuidora',
  })
  totals!: AgingBucketsDto;
  @ApiProperty({ type: [AgingAccountRowDto] }) accounts!: AgingAccountRowDto[];
}
