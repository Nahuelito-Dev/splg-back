import { ApiProperty } from '@nestjs/swagger';

/** Qué hecho es cada ítem de la traza. */
export enum TraceItemKind {
  /** Un asiento de `audit_log`: una escritura HTTP con ese request id. */
  AUDIT = 'audit',
  /** Una corrida de proceso automático con esa traza. */
  PROCESS_RUN = 'process_run',
  /** Un aviso de la bandeja (de una empresa o de la plataforma) con esa traza. */
  NOTIFICATION = 'notification',
}

export class TraceLinkDto {
  @ApiProperty({
    example: 'process-run',
    description:
      'Tipo de lo enlazado: `process-run`, `admin-notification` o el recurso del asiento (`orders`, `users`…)',
  })
  entity!: string;

  @ApiProperty({ example: '6b1e2a40-9c3d-4e5f-8a7b-1c2d3e4f5a6b' })
  id!: string;
}

export class TraceItemDto {
  @ApiProperty({ description: 'Cuándo pasó' })
  at!: Date;

  @ApiProperty({ enum: TraceItemKind })
  kind!: TraceItemKind;

  @ApiProperty({
    example: 'Bandeja de avisos de pago: procesamiento — ok (webhook, 412 ms)',
    description:
      'Resumen sin datos personales: método, ruta patrón y código; proceso, estado y duración; o tipo de aviso',
  })
  summary!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Empresa del hecho; `null` si es de la plataforma',
  })
  distributorId!: string | null;

  @ApiProperty({ type: TraceLinkDto, nullable: true })
  link!: TraceLinkDto | null;
}

export class TraceResponseDto {
  @ApiProperty({ example: 'prueba-o1' })
  traceId!: string;

  @ApiProperty({
    type: [TraceItemDto],
    description: 'Línea de tiempo, lo más viejo primero',
  })
  items!: TraceItemDto[];
}
