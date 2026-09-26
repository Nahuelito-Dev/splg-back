import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ClaimStatus } from '../entities/claim.entity';

/**
 * Body de `PATCH /claims/:id/resolve`. Valida que `status` sea un estado real de
 * reclamo (rechaza con 400 claro antes de tocar la DB) y que `resolution` no sea
 * vacío. Reemplaza el tipo inline sin validación.
 */
export class ResolveClaimDto {
  @ApiProperty({ description: 'Texto de resolución del reclamo' })
  @IsString()
  @IsNotEmpty()
  resolution!: string;

  @ApiProperty({
    description: 'Nuevo estado del reclamo',
    enum: ClaimStatus,
    example: ClaimStatus.RESOLVED,
  })
  @IsEnum(ClaimStatus, {
    message: `status debe ser uno de: ${Object.values(ClaimStatus).join(', ')}`,
  })
  status!: ClaimStatus;
}
