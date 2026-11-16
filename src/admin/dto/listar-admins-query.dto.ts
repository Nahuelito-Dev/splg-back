import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ListarAdminsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sólo para el super admin: lista los admins de esta distribuidora, ' +
      'aunque esté "viendo como" otra. Un admin de empresa sólo puede pedir ' +
      'la suya; otra es 403.',
  })
  @IsOptional()
  @IsUUID()
  distributorId?: string;
}
