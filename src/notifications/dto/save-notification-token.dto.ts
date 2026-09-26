import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, IsUUID } from 'class-validator';

/** Plataformas desde las que puede llegar un token de notificaciones. */
export enum PlataformaNotificacion {
  ANDROID = 'android',
  IOS = 'ios',
  WEB = 'web',
}

/** Registro del token de un dispositivo para poder avisarle. */
export class SaveNotificationTokenDto {
  @ApiProperty({ description: 'Usuario dueño del dispositivo' })
  @IsUUID('4', { message: 'userId debe ser un UUID' })
  userId!: string;

  @ApiProperty({ description: 'Token de FCM del dispositivo' })
  @IsString()
  @IsNotEmpty({ message: 'token no puede estar vacío' })
  token!: string;

  @ApiProperty({
    description: 'Desde qué plataforma se registra',
    enum: PlataformaNotificacion,
  })
  @IsEnum(PlataformaNotificacion, {
    message: 'platform debe ser android, ios o web',
  })
  platform!: PlataformaNotificacion;
}
