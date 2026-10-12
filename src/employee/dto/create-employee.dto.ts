import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  EmployeeDocumentType,
  EmploymentType,
} from '../entities/employee.entity';
import { VacioANulo } from './vacio-a-nulo.decorator';
import { Cuil } from './is-cuil.decorator';
import {
  FechaCalendario,
  FechaCalendarioOpcional,
} from './fecha-calendario.decorator';

const sinEspacios = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Los datos del legajo que se cargan o corrigen a mano (CU-177, CU-178). */
export class CreateEmployeeDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Puesto activo de la distribuidora',
  })
  @IsUUID()
  positionId!: string;

  @ApiPropertyOptional({
    example: '0042',
    maxLength: 20,
    description:
      'Si falta, toma el siguiente número correlativo de la distribuidora',
  })
  @IsOptional()
  @VacioANulo(undefined)
  @Transform(sinEspacios)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  fileNumber?: string;

  @ApiProperty({ example: 'Ana', maxLength: 80 })
  @Transform(sinEspacios)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ example: 'Pérez', maxLength: 80 })
  @Transform(sinEspacios)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @ApiProperty({ enum: EmployeeDocumentType, example: 'dni' })
  @IsEnum(EmployeeDocumentType)
  documentType!: EmployeeDocumentType;

  @ApiProperty({ example: '30123456', maxLength: 20 })
  @Transform(sinEspacios)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  documentNumber!: string;

  @Cuil()
  cuil?: string | null;

  @FechaCalendarioOpcional('1990-05-17')
  birthDate?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Av. Corrientes 1234',
    maxLength: 200,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(200)
  addressLine?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Posadas',
    maxLength: 80,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(80)
  city?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Misiones',
    maxLength: 80,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(80)
  province?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '3300',
    maxLength: 10,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(10)
  postalCode?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+5493764000000',
    maxLength: 30,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'ana@correo.com',
    maxLength: 120,
  })
  @IsOptional()
  @VacioANulo()
  @IsEmail()
  @MaxLength(120)
  personalEmail?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Luis Pérez',
    maxLength: 120,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(120)
  emergencyContactName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+5493764111111',
    maxLength: 30,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(30)
  emergencyContactPhone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Hermano',
    maxLength: 40,
  })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(40)
  emergencyContactRelationship?: string | null;

  @FechaCalendario('2026-03-01')
  hireDate!: string;

  @ApiProperty({ enum: EmploymentType, example: 'permanent' })
  @IsEnum(EmploymentType)
  employmentType!: EmploymentType;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0170099220000067890123',
    description: '22 dígitos',
  })
  @IsOptional()
  @VacioANulo()
  @Matches(/^\d{22}$/, { message: 'bankCbu tiene que tener 22 dígitos' })
  bankCbu?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @VacioANulo()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

/** Todo opcional: se manda sólo lo que cambia. El estado y el egreso no se editan por acá. */
export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}
