import { ApiProperty } from '@nestjs/swagger';
import {
  ProcessHealth,
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from '../domain/process-catalog';

export class ProcessRunResponseDto {
  @ApiProperty({ example: '9d8e7f60-1b2c-4d3e-8f4a-5b6c7d8e9f01' })
  id!: string;

  @ApiProperty({ enum: ProcessName })
  process!: ProcessName;

  @ApiProperty({ example: 'Recompra: invitaciones anticipadas' })
  title!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Distribuidora de la corrida; `null` si fue un barrido global',
  })
  distributorId!: string | null;

  @ApiProperty()
  startedAt!: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: '`null` mientras corre',
  })
  finishedAt!: Date | null;

  @ApiProperty({ type: Number, nullable: true, example: 1840 })
  durationMs!: number | null;

  @ApiProperty({ enum: ProcessRunStatus })
  status!: ProcessRunStatus;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { processed: 3, errors: 0 },
    description:
      'Lo que generó la corrida (casos, avisos, ofertas...), según el proceso. `errors`: elementos que fallaron en esta corrida (la deja `partial`; se reintentan en la próxima). `persistentFailures` (sólo si hay): de esos, los que vienen fallando hace 3 corridas seguidas o más; al llegar a 3 se avisa una vez a la plataforma.',
  })
  counters!: Record<string, number>;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;

  @ApiProperty({ enum: RunTrigger })
  trigger!: RunTrigger;
}

export class ProcessRunListResponseDto {
  @ApiProperty({ type: [ProcessRunResponseDto] })
  items!: ProcessRunResponseDto[];

  @ApiProperty({ example: 42 })
  total!: number;
}

export class ProcessSummaryItemDto {
  @ApiProperty({ enum: ProcessName })
  process!: ProcessName;

  @ApiProperty({ example: 'Recompra: invitaciones anticipadas' })
  title!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['M1', 'M2', 'M3', 'M4', 'M5'],
    description: 'Módulo inteligente; `null` si es una tarea programada común',
  })
  module!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: '`null` si el proceso corre como barrido global',
  })
  distributorId!: string | null;

  @ApiProperty({
    enum: ProcessHealth,
    description:
      '`late`: no arrancó en 1,5 veces su período; `stuck`: sigue corriendo pasado el máximo; `failed`: la última terminó con error; `never`: todavía no corrió',
  })
  health!: ProcessHealth;

  @ApiProperty({ type: ProcessRunResponseDto, nullable: true })
  lastRun!: ProcessRunResponseDto | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'Inicio de la última corrida que terminó bien',
  })
  lastOkAt!: Date | null;

  @ApiProperty({
    example: 3600,
    description: 'Cada cuántos segundos se espera una corrida',
  })
  expectedEverySeconds!: number;

  @ApiProperty({ type: Date, nullable: true })
  nextExpectedAt!: Date | null;
}

export class ProcessSummaryResponseDto {
  @ApiProperty({ type: [ProcessSummaryItemDto] })
  items!: ProcessSummaryItemDto[];

  @ApiProperty({
    example: 1,
    description: 'Procesos atrasados, fallidos o colgados',
  })
  alerts!: number;

  @ApiProperty()
  generatedAt!: Date;
}

/** Un aviso de la bandeja que salió de la misma traza que la corrida. */
export class ProcessRunNotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'process_circuit_open' })
  kind!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: '`null`: aviso a la bandeja de la plataforma',
  })
  distributorId!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

/** Detalle de una corrida (DISENO-OBSERVABILIDAD §7.1). */
export class ProcessRunDetailResponseDto extends ProcessRunResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'],
    description: 'Módulo inteligente; `null` si es una tarea programada común',
  })
  module!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Quién la pidió; sólo en las corridas `manual`',
  })
  requestedBy!: string | null;

  @ApiProperty({
    example: 'orix:4121',
    description: '`host:pid` de la instancia que la corrió',
  })
  instance!: string;

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: { type: 'number' },
    example: {
      ok: 7,
      failed: 1,
      timeout: 0,
      locked: 0,
      circuit_open: 0,
      paused: 0,
      skipped: 3,
    },
    description:
      'Cuántas empresas terminaron en cada estado; `null` si el proceso no recorre empresas',
  })
  companies!: Record<string, number> | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'a91f03c2d4e5b6f7',
    description:
      'Huella del error (16 hexadecimales): la misma para el mismo error en otras corridas',
  })
  errorFingerprint!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'prueba-o1',
    description:
      'Traza de la corrida: el `X-Request-Id` del request que la disparó o su propio id si nació del cron. Se abre con `GET /v2/platform/traces/{traceId}`',
  })
  traceId!: string | null;

  @ApiProperty({
    type: [ProcessRunNotificationDto],
    description: 'Avisos de la bandeja con la misma traza',
  })
  notifications!: ProcessRunNotificationDto[];
}
