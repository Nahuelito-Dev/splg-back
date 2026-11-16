import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PERMISOS } from '../../common/permisos/catalogo';

const sinEspacios = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Vacía o sólo espacios: sin descripción. */
const descripcionONulo = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const limpia = value.trim();
  return limpia === '' ? null : limpia;
};

export class CreateStaffRoleDto {
  @ApiProperty({
    example: 'Encargado de depósito',
    minLength: 2,
    maxLength: 60,
  })
  @Transform(sinEspacios)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({
    example: 'Stock, compras y cargas de camión',
    maxLength: 300,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(descripcionONulo)
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @ApiProperty({
    type: [String],
    example: ['stock.gestionar', 'compras.gestionar'],
    description:
      'Claves del catálogo (`GET /v2/permissions`). `gestionar` ya incluye `ver` del mismo módulo. Una clave fuera del catálogo responde 400 con su nombre.',
  })
  @IsArray()
  @ArrayMaxSize(PERMISOS.length)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  permissions!: string[];
}

export class UpdateStaffRoleDto extends PartialType(CreateStaffRoleDto) {}

export class AssignStaffRoleDto {
  @ApiProperty({ format: 'uuid', description: 'Rol de personal a asignar' })
  @IsUUID()
  staffRoleId!: string;
}

export class PermissionResponseDto {
  @ApiProperty({ example: 'pedidos.gestionar' })
  key!: string;

  @ApiProperty({ example: 'gestionar los pedidos' })
  label!: string;

  @ApiProperty({ example: 'Crear, editar, cancelar y cobrar pedidos.' })
  description!: string;

  @ApiProperty({
    type: [String],
    example: ['pedidos.ver'],
    description: 'Permisos que vienen incluidos con este',
  })
  implies!: string[];
}

export class PermissionModuleResponseDto {
  @ApiProperty({ example: 'pedidos' })
  key!: string;

  @ApiProperty({ example: 'Pedidos y despacho' })
  label!: string;

  @ApiProperty({ type: [PermissionResponseDto] })
  permissions!: PermissionResponseDto[];
}

export class StaffRoleResponseDto {
  @ApiProperty({ format: 'uuid' })
  staffRoleId!: string;

  @ApiProperty({ example: 'Encargado de depósito' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    description:
      'Rol de sistema («Administrador»): tiene todos los permisos y no se edita ni se da de baja',
  })
  isSystem!: boolean;

  @ApiProperty({
    type: [String],
    example: ['stock.gestionar', 'compras.gestionar'],
    description:
      'Permisos elegidos, en el orden del catálogo. El rol de sistema lista el catálogo entero.',
  })
  permissions!: string[];

  @ApiProperty({
    example: 2,
    description: 'Administradores (no dados de baja) con este rol',
  })
  adminCount!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class StaffRoleSummaryDto {
  @ApiProperty({ format: 'uuid' })
  staffRoleId!: string;

  @ApiProperty({ example: 'Administrador' })
  name!: string;

  @ApiProperty()
  isSystem!: boolean;
}

export class AdminStaffRoleResponseDto {
  @ApiProperty({ format: 'uuid' })
  adminId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: StaffRoleSummaryDto })
  staffRole!: StaffRoleSummaryDto;
}

export class MyPermissionsResponseDto {
  @ApiProperty({ enum: ['admin', 'super_admin'] })
  role!: string;

  @ApiProperty({
    description:
      'Tiene todos los permisos (super admin o rol de sistema): el panel no oculta nada',
  })
  allPermissions!: boolean;

  @ApiProperty({
    type: StaffRoleSummaryDto,
    nullable: true,
    description: 'Rol de personal del administrador; null para el super admin',
  })
  staffRole!: StaffRoleSummaryDto | null;

  @ApiProperty({
    type: [String],
    example: ['pedidos.ver', 'pedidos.gestionar'],
    description:
      'Permisos efectivos, con los `ver` que implica cada `gestionar`, en el orden del catálogo',
  })
  permissions!: string[];
}
