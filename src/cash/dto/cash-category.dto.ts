import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, MaxLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { CashSystemCode, CategoryDirection } from '../domain/cash.enums';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateCashCategoryDto {
  @ApiProperty({ example: 'Limpieza', maxLength: 80 })
  @TextoNoVacio()
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    enum: CategoryDirection,
    example: CategoryDirection.EXPENSE,
    description: '`income` es de ingresos y `expense` de gastos',
  })
  @IsEnum(CategoryDirection)
  direction!: CategoryDirection;
}

export class UpdateCashCategoryDto {
  @ApiPropertyOptional({ example: 'Limpieza y mantenimiento', maxLength: 80 })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ description: 'false la desactiva' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryCashCategoryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: CategoryDirection })
  @IsOptional()
  @IsEnum(CategoryDirection)
  direction?: CategoryDirection;

  @ApiPropertyOptional({ description: 'También las desactivadas' })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  includeInactive?: boolean;
}

export class CashCategoryResponseDto {
  @ApiProperty() categoryId!: string;
  @ApiProperty({ example: 'Limpieza' }) name!: string;
  @ApiProperty({ enum: CategoryDirection }) direction!: CategoryDirection;
  @ApiProperty({
    enum: CashSystemCode,
    nullable: true,
    description: 'Las de sistema no se editan ni se desactivan',
  })
  systemCode!: CashSystemCode | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CashCategoryPageDto {
  @ApiProperty({ type: [CashCategoryResponseDto] })
  data!: CashCategoryResponseDto[];
  @ApiProperty({ example: 12 }) total!: number;
}
