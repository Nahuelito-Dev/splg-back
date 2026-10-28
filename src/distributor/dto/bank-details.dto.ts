import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ALIAS_BANCARIO_REGEX,
  MAX_TITULAR_BANCARIO,
  MIN_TITULAR_BANCARIO,
} from '../../common/utils/datos-bancarios';
import { EsCbu } from '../validators/es-cbu.validator';

/** Un texto vacío o de puros espacios equivale a "sin dato" (`null`). */
const vacioANull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() || null : value;

/**
 * Cuerpo de `PUT /v2/distributor/bank-details`. Reemplaza los tres datos: lo que
 * no se manda (o se manda `null` o vacío) queda sin cargar.
 */
export class BankDetailsDto {
  @ApiPropertyOptional({
    type: String,
    description: 'CBU: 22 dígitos con los dígitos verificadores válidos',
    example: '0170099220000067797370',
    nullable: true,
  })
  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @EsCbu()
  cbu?: string | null;

  @ApiPropertyOptional({
    type: String,
    description:
      'Alias: 6 a 20 caracteres entre letras, números, punto y guion',
    example: 'garrafas.splg',
    nullable: true,
  })
  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @Matches(ALIAS_BANCARIO_REGEX, {
    message:
      'alias tiene que tener entre 6 y 20 caracteres: letras, números, punto y guion',
  })
  alias?: string | null;

  @ApiPropertyOptional({
    type: String,
    description: 'Titular de la cuenta',
    example: 'Distribuidora Demo S.A.',
    nullable: true,
    minLength: MIN_TITULAR_BANCARIO,
    maxLength: MAX_TITULAR_BANCARIO,
  })
  @IsOptional()
  @Transform(vacioANull)
  @IsString()
  @MinLength(MIN_TITULAR_BANCARIO)
  @MaxLength(MAX_TITULAR_BANCARIO)
  holder?: string | null;
}

/** Datos para cobrar por transferencia; `null` en lo que la distribuidora no cargó. */
export class BankDetailsResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '0170099220000067797370',
  })
  cbu!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'garrafas.splg' })
  alias!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Distribuidora Demo S.A.',
  })
  holder!: string | null;
}
