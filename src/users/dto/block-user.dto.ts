import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Bloqueo o desbloqueo de una cuenta. */
export class BlockUserDto {
  @ApiProperty({
    description: 'true bloquea la cuenta, false la habilita de nuevo',
    example: true,
  })
  @IsBoolean({ message: 'block tiene que ser true o false' })
  block!: boolean;
}
