import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, MaxLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { CashBoxKind } from '../domain/cash.enums';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateCashBoxDto {
  @ApiProperty({ example: 'Caja del mostrador', maxLength: 80 })
  @TextoNoVacio()
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    enum: CashBoxKind,
    example: CashBoxKind.CASH,
    description: 'Efectivo, banco o billetera virtual',
  })
  @IsEnum(CashBoxKind)
  kind!: CashBoxKind;

  @ApiPropertyOptional({
    description:
      'Si exige abrir una sesión (y cerrarla con arqueo) para mover dinero. Por omisión, sí para efectivo.',
  })
  @IsOptional()
  @IsBoolean()
  requiresSession?: boolean;
}

export class UpdateCashBoxDto {
  @ApiPropertyOptional({ example: 'Caja del mostrador', maxLength: 80 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({
    description: 'false la desactiva (409 si tiene una sesión abierta)',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Cambiar esto con una sesión abierta responde 409',
  })
  @IsOptional()
  @IsBoolean()
  requiresSession?: boolean;
}

export class QueryCashBoxDto extends PaginationDto {
  @ApiPropertyOptional({ enum: CashBoxKind })
  @IsOptional()
  @IsEnum(CashBoxKind)
  kind?: CashBoxKind;

  @ApiPropertyOptional({ description: 'También las desactivadas' })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  includeInactive?: boolean;
}

export class CashBoxResponseDto {
  @ApiProperty() cashBoxId!: string;
  @ApiProperty({ example: 'Caja central' }) name!: string;
  @ApiProperty({ enum: CashBoxKind }) kind!: CashBoxKind;
  @ApiProperty({ example: 15400.5, description: 'Saldo según el libro' })
  balance!: number;
  @ApiProperty() requiresSession!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sesión abierta de la caja, si tiene',
  })
  openSessionId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CashBoxPageDto {
  @ApiProperty({ type: [CashBoxResponseDto] }) data!: CashBoxResponseDto[];
  @ApiProperty({ example: 3 }) total!: number;
}
