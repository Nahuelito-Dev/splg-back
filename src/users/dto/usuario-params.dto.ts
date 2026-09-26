import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, Matches } from 'class-validator';

/** `GET /users/email/:email`: el correo tiene que ser un correo. */
export class EmailParamDto {
  @ApiProperty({ example: 'ana@splg.com' })
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email!: string;
}

/** `GET /users/phone/:phoneNumber`: en E.164, como lo guarda el alta. */
export class TelefonoParamDto {
  @ApiProperty({ example: '+5493764000000' })
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phoneNumber tiene que estar en formato E.164 (+549...)',
  })
  phoneNumber!: string;
}
