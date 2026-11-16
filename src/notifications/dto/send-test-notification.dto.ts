import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Envío de una notificación de prueba a un dispositivo puntual. */
export class SendTestNotificationDto {
  @ApiProperty({ description: 'Token de FCM del dispositivo destino' })
  @IsString()
  @IsNotEmpty({ message: 'token no puede estar vacío' })
  token!: string;

  @ApiProperty({ description: 'Título del aviso', example: 'Prueba' })
  @IsString()
  @IsNotEmpty({ message: 'title no puede estar vacío' })
  @MaxLength(100)
  title!: string;

  @ApiProperty({ description: 'Cuerpo del aviso' })
  @IsString()
  @IsNotEmpty({ message: 'body no puede estar vacío' })
  @MaxLength(500)
  body!: string;
}
