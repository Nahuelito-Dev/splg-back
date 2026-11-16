import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReleaseFraudHoldDto {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example:
      'Hablé con el cliente y verifiqué el pago en Mercado Pago: es legítimo',
    description:
      'Motivo con el que se libera la retención por alerta de fraude. Queda guardado con quién y cuándo (auditado).',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
