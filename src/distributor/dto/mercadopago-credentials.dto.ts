import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SaveMercadoPagoCredentialsDto {
  @ApiProperty({
    description:
      'Access token de la cuenta. Se verifica contra Mercado Pago antes de guardarlo.',
    example: 'APP_USR-0000000000000000-000000-00000000000000000000000000000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  accessToken!: string;

  @ApiProperty({
    description: 'Clave pública de la cuenta (la que usan las apps).',
    example: 'APP_USR-00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  publicKey!: string;

  @ApiProperty({
    description:
      'Secreto con el que Mercado Pago firma las notificaciones (webhook) de esta cuenta.',
    example: 'secreto-del-webhook',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  webhookSecret!: string;
}

export type MercadoPagoAccountType = 'test' | 'real' | 'unknown';

export class MercadoPagoCredentialsResponseDto {
  @ApiProperty({
    enum: ['test', 'real', 'unknown'],
    description:
      'Tipo de la cuenta con la que se cobra (la propia si hay, si no la del sistema), según `GET /users/me` de Mercado Pago: `test` = «Cuenta de prueba» (usuario de prueba, no cobra de verdad), `real` = «Cuenta real», `unknown` = no se pudo consultar o no hay token.',
  })
  accountType!: MercadoPagoAccountType;

  @ApiProperty({
    enum: ['own', 'system'],
    description:
      '`own`: se cobra con la cuenta de la distribuidora. `system`: con la del sistema.',
  })
  source!: 'own' | 'system';

  @ApiProperty({ description: 'Hay una cuenta propia cargada y activa.' })
  active!: boolean;

  @ApiProperty({
    description:
      'El servidor tiene la clave de cifrado: sin ella no se pueden cargar credenciales propias.',
  })
  encryptionConfigured!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'APP_USR-…1234' })
  accessTokenMasked!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'APP_USR-…1234' })
  publicKeyMasked!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '••••1234' })
  webhookSecretMasked!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo Mercado Pago aceptó por última vez el token.',
  })
  verifiedAt!: Date | null;
}
