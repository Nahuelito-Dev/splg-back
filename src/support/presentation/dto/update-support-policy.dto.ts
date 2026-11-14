import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** Cambio de la política de soporte de la empresa (lo que no viene, no cambia). */
export class UpdateSupportPolicyDto {
  @ApiPropertyOptional({
    description:
      'Si el soporte puede abrir un acceso de emergencia sin aprobación',
  })
  @IsOptional()
  @IsBoolean()
  emergencyAllowed?: boolean;

  @ApiPropertyOptional({
    description:
      'Si los pedidos de acceso se aprueban solos, tal como se pidieron',
  })
  @IsOptional()
  @IsBoolean()
  autoApprove?: boolean;
}
