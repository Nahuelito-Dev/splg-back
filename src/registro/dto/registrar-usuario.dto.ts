import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
  MinLength,
  IsLatLong,
} from 'class-validator';
import { LegajoDeChoferDto } from './legajo-de-chofer.dto';
import { ROLES_REGISTRABLES } from '../politica-de-registro';
import type { RolRegistrable } from '../politica-de-registro';

/**
 * Alta desde la puerta pública (`POST /auth/registro`): siempre un cliente.
 * No lleva rol ni distribuidora; como el ValidationPipe rechaza los campos de
 * más, desde afuera no se pueden colar.
 */
export class RegistrarClienteDto {
  @ApiProperty({ example: 'ana@correo.com' })
  @IsEmail()
  email!: string;

  // Firebase exige al menos 6 caracteres.
  @ApiProperty({ example: 'Test1234', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({ example: 'Ana Pérez' })
  @IsString()
  @MinLength(2)
  full_name!: string;

  // Firebase guarda el teléfono en formato E.164.
  @ApiProperty({ example: '+5493764000000' })
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone_number tiene que estar en formato E.164 (+549...)',
  })
  phone_number!: string;

  @ApiPropertyOptional({ description: 'Ubicación inicial "lat,lng"' })
  @IsOptional()
  @IsLatLong({
    message:
      'lat_lang debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961',
  })
  lat_lang?: string;

  @ApiPropertyOptional({ description: 'Token FCM del dispositivo' })
  @IsOptional()
  @IsString()
  notification_token?: string;
}

/**
 * Alta desde el panel (`POST /users`): el rol decide qué perfil se crea. Los
 * campos de un perfil que no corresponde al rol se ignoran.
 */
export class RegistrarUsuarioDto extends RegistrarClienteDto {
  @ApiProperty({ enum: ROLES_REGISTRABLES, example: 'delivery' })
  @IsIn(ROLES_REGISTRABLES)
  rol!: RolRegistrable;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Distribuidora de un chofer o admin. Un admin sólo puede indicar la ' +
      'suya; un super admin, cualquiera (o usar X-Distributor).',
  })
  @IsOptional()
  @IsUUID()
  distributorId?: string;

  @ApiPropertyOptional({
    description:
      'Chofer ya validado por el administrador. Los clientes no se validan: se registran y compran',
  })
  @IsOptional()
  @IsBoolean()
  validated?: boolean;

  @ApiPropertyOptional({
    description:
      'Chofer: habilitado para operar (se guarda como `delivery.isEnabled`; ' +
      'el chofer arranca desconectado y se pone en línea desde su app)',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Chofer: base "lat,lng"' })
  @IsOptional()
  @IsLatLong({
    message:
      'latLng debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961',
  })
  latLng?: string;

  @ApiPropertyOptional({ description: 'Chofer: última ubicación conocida' })
  @IsOptional()
  @IsString()
  actual_location?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Chofer o admin: legajo existente (sin cuenta) al que se vincula el usuario ' +
      'en vez de crear otro. El puesto tiene que admitir el rol. Excluye a `legajo`',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    type: LegajoDeChoferDto,
    description:
      'Chofer: datos del legajo que se crea con la cuenta, en la misma transacción',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LegajoDeChoferDto)
  legajo?: LegajoDeChoferDto;
}
