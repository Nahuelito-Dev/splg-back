import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ConfirmDepositV2Dto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Caja de EFECTIVO donde entra la seña recibida en efectivo. Obligatoria si la distribuidora tiene alguna caja de efectivo activa (400 si falta o no es de efectivo); la de otra distribuidora es 404 y una que exige sesión sin sesión abierta, 409.',
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
}
