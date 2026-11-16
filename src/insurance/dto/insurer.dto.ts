import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { esCuitValido, normalizarCuit } from '../../purchase/domain/cuit';

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

const ENLACE_HTTPS = /^https:\/\/[^\s]+$/;
const ENLACE_WEB = /^https?:\/\/[^\s]+$/;

export class CreateInsurerDto {
  @ApiProperty({ example: 'Seguros Rivadavia', maxLength: 120 })
  @TextoNoVacio()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '30500050207',
    description: 'CUIT de 11 dígitos (se aceptan guiones)',
  })
  @VacioANulo()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizarCuit(value.trim()) : value,
  )
  @EsCuit()
  taxId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0800-444-4000',
    maxLength: 40,
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[0-9+()\-\s]{6,40}$/, {
    message: 'phone: sólo dígitos, espacios, +, guiones y paréntesis',
  })
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'siniestros@aseguradora.com',
    maxLength: 120,
  })
  @VacioANulo()
  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://www.aseguradora.com',
    maxLength: 255,
  })
  @VacioANulo()
  @IsOptional()
  @MaxLength(255)
  @Matches(ENLACE_WEB, { message: 'website: tiene que ser una URL http(s)' })
  website?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://pagos.aseguradora.com/cuotas',
    maxLength: 500,
    description:
      'Página de pago de la aseguradora (https). El aviso de la cuota se la muestra al admin',
  })
  @VacioANulo()
  @IsOptional()
  @MaxLength(500)
  @Matches(ENLACE_HTTPS, {
    message: 'paymentUrl: tiene que ser una URL https',
  })
  paymentUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UpdateInsurerDto extends PartialType(CreateInsurerDto) {}

export class QueryInsurerDto extends PaginationDto {}

export class InsurerResponseDto {
  @ApiProperty({ format: 'uuid' })
  insurerId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  taxId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  website!: string | null;

  @ApiProperty({ type: String, nullable: true })
  paymentUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class InsurerPageDto {
  @ApiProperty({ type: [InsurerResponseDto] })
  data!: InsurerResponseDto[];

  @ApiProperty()
  total!: number;
}
