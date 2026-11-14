import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsDefined } from 'class-validator';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';

/** Cuerpo de `PUT /v2/platform/companies/:id/owned-by-platform`. */
export class SetOwnedByPlatformDto {
  @ApiProperty({
    description:
      'true: la empresa pasa a ser propia de la plataforma (el administrador general la opera directo, sin sesión de soporte); false: vuelve a ser una empresa cliente',
  })
  @IsDefined()
  @IsBoolean()
  ownedByPlatform!: boolean;
}

/** Una empresa vista desde la plataforma (sin datos bancarios ni credenciales). */
export class PlatformCompanyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Distribuidora de prueba OrixTech' })
  name!: string;

  @ApiProperty({ example: 'prueba-orixtech' })
  slug!: string;

  @ApiProperty({ enum: DistributorStatus })
  status!: DistributorStatus;

  @ApiProperty({
    description:
      'Empresa propia de la plataforma: el administrador general la opera con `X-Distributor`, sin sesión de soporte',
  })
  ownedByPlatform!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}
