import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { esCuitValido, normalizarCuit } from '../domain/cuit';
import { SupplierKind } from '../domain/purchase.enums';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** CUIT con prefijo y dígito verificador válidos (acepta guiones y espacios). */
function EsCuit(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'esCuit',
      target: target.constructor,
      propertyName: String(propertyKey),
      options: {
        message: 'cuit: no es un CUIT válido (11 dígitos y dígito verificador)',
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && esCuitValido(value),
      },
    });
}

export class CreateSupplierDto {
  @ApiProperty({ example: 'Gas del Litoral S.A.', maxLength: 120 })
  @TextoNoVacio()
  @MaxLength(120)
  businessName!: string;

  @ApiProperty({
    example: '30715123456',
    description:
      'CUIT de 11 dígitos (se aceptan guiones). Único entre los proveedores vigentes de la distribuidora.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizarCuit(value.trim()) : value,
  )
  @EsCuit()
  cuit!: string;

  @ApiProperty({
    enum: SupplierKind,
    example: SupplierKind.FILLING_PLANT,
    description:
      '`filling_plant` es la planta fraccionadora que llena y canjea envases',
  })
  @IsEnum(SupplierKind)
  kind!: SupplierKind;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Marta Gómez',
    maxLength: 80,
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  contactName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+5493624123456',
    maxLength: 30,
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^[0-9+()\-\s]{6,30}$/, {
    message: 'phone: sólo dígitos, espacios, +, guiones y paréntesis',
  })
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'email',
    example: 'compras@gasdellitoral.com.ar',
  })
  @VacioANulo()
  @IsOptional()
  @IsEmail()
  @MaxLength(120)
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Ruta 11 km 1005, Resistencia',
    maxLength: 300,
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 30,
    minimum: 0,
    maximum: 365,
    description: 'Plazo de pago en días (0 = contado)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number | null;
}

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {
  @ApiPropertyOptional({
    description: 'false lo deja fuera de las listas de operación',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  isActive?: boolean;
}

export class QuerySupplierDto extends PickType(PaginationDto, [
  'page',
  'limit',
  'term',
] as const) {
  @ApiPropertyOptional({ enum: SupplierKind })
  @IsOptional()
  @IsEnum(SupplierKind)
  kind?: SupplierKind;

  @ApiPropertyOptional({
    description:
      'true también trae los proveedores inactivos (default: sólo los activos)',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  includeInactive?: boolean;
}

export class SupplierResponseDto {
  @ApiProperty({ format: 'uuid' }) supplierId!: string;
  @ApiProperty({ example: 'Gas del Litoral S.A.' }) businessName!: string;
  @ApiProperty({ example: '30715123456' }) cuit!: string;
  @ApiProperty({ enum: SupplierKind }) kind!: SupplierKind;
  @ApiProperty({ nullable: true, type: String }) contactName!: string | null;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ nullable: true, type: Number, example: 30 })
  paymentTermsDays!: number | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class SupplierPageDto {
  @ApiProperty({ type: SupplierResponseDto, isArray: true })
  data!: SupplierResponseDto[];
  @ApiProperty({ example: 12 }) total!: number;
}
