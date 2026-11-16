import { ApiProperty } from '@nestjs/swagger';
import { AuditResult } from '../entities/audit-log.entity';

/** Un asiento del registro de auditoría, tal como lo consulta el panel. */
export class AsientoDeAuditoriaDto {
  @ApiProperty({ format: 'uuid' })
  auditId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  distributorId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorUserId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'admin' })
  actorRole!: string | null;

  @ApiProperty({ example: 'PATCH' })
  httpMethod!: string;

  @ApiProperty({ example: 'orders' })
  resource!: string;

  @ApiProperty({ type: String, nullable: true })
  resourceId!: string | null;

  @ApiProperty({ example: '/api/orders/:id/status' })
  path!: string;

  @ApiProperty({ type: String, nullable: true, example: 'panel-app' })
  clientSource!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;

  @ApiProperty({ enum: AuditResult })
  result!: AuditResult;

  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'El cuerpo de la operación, sin credenciales',
  })
  changes!: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class RegistroDeAuditoriaDto {
  @ApiProperty({ type: AsientoDeAuditoriaDto, isArray: true })
  items!: AsientoDeAuditoriaDto[];

  @ApiProperty()
  total!: number;
}
