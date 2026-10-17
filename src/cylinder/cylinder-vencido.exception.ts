import { ConflictException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

/** Cuerpo del 409 cuando se rechaza un despacho por envases vencidos. */
export class CylinderExpiredResponseDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ example: 'Conflict' }) error!: string;
  @ApiProperty({ example: 'CYLINDER_EXPIRED' }) code!: string;
  @ApiProperty({
    example: 'Envases con la revisión vencida: SN-000123',
  })
  message!: string;
  @ApiProperty({ type: String, isArray: true, example: ['SN-000123'] })
  serials!: string[];
}

/**
 * CU-135. La asignación se rechaza completa porque algún envase tiene la
 * revisión vencida. Responde 409 con la lista de seriales para que quien asigna
 * elija otros.
 */
export class EnvasesVencidosException extends ConflictException {
  constructor(readonly serials: string[]) {
    super({
      statusCode: 409,
      error: 'Conflict',
      code: 'CYLINDER_EXPIRED',
      message: `Envases con la revisión vencida: ${serials.join(', ')}`,
      serials,
    });
  }
}
