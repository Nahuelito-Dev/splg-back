import { ApiProperty } from '@nestjs/swagger';
import {
  SupportEndReason,
  SupportScope,
  SupportSessionKind,
  SupportSessionStatus,
} from '../../domain/support-session.enums';

/** Una persona que actuó sobre la sesión (sin datos de contacto). */
export class SupportActorDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ana Pérez' })
  fullName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Foto de perfil: URL firmada de S3 de corta vigencia, o null si no tiene',
  })
  photoUrl!: string | null;
}

/** Una sesión de soporte (pedido, sesión activa o historial). */
export class SupportSessionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  distributorId!: string;

  @ApiProperty({ example: 'Gas del Norte' })
  distributorName!: string;

  @ApiProperty({ type: SupportActorDto })
  requestedBy!: SupportActorDto;

  @ApiProperty({ enum: SupportSessionKind })
  kind!: SupportSessionKind;

  @ApiProperty({ enum: SupportSessionStatus })
  status!: SupportSessionStatus;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: String, nullable: true })
  ticketRef!: string | null;

  @ApiProperty({ enum: SupportScope, isArray: true })
  scope!: SupportScope[];

  @ApiProperty({ example: 60 })
  requestedMinutes!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Hasta cuándo la empresa puede responder el pedido',
  })
  requestExpiresAt!: string | null;

  @ApiProperty({ type: SupportActorDto, nullable: true })
  decidedBy!: SupportActorDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  decisionNote!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt!: string | null;

  @ApiProperty({ type: SupportActorDto, nullable: true })
  endedBy!: SupportActorDto | null;

  @ApiProperty({ enum: SupportEndReason, nullable: true })
  endReason!: SupportEndReason | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

/** `GET /v2/support-sessions/current`: la sesión actual o `null` (en un objeto, para que el JSON sea siempre un objeto). */
export class SupportSessionCurrentResponseDto {
  @ApiProperty({ type: SupportSessionResponseDto, nullable: true })
  session!: SupportSessionResponseDto | null;
}

export class SupportSessionListResponseDto {
  @ApiProperty({ type: SupportSessionResponseDto, isArray: true })
  items!: SupportSessionResponseDto[];

  @ApiProperty({ example: 3 })
  total!: number;
}

/** Una consulta hecha en una sesión de soporte («qué miró»). */
export class SupportAccessEntryDto {
  @ApiProperty({ example: '42' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;

  @ApiProperty({ example: 'GET' })
  httpMethod!: string;

  @ApiProperty({ example: '/api/v2/orders/:id' })
  path!: string;

  @ApiProperty({ type: String, nullable: true, example: 'orders' })
  resource!: string | null;

  @ApiProperty({ type: String, nullable: true })
  resourceId!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Filtros depurados (la búsqueda libre no se guarda en claro)',
  })
  query!: Record<string, unknown> | null;

  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ type: Number, nullable: true })
  items!: number | null;

  @ApiProperty()
  masked!: boolean;
}

export class SupportAccessListResponseDto {
  @ApiProperty({ type: SupportAccessEntryDto, isArray: true })
  items!: SupportAccessEntryDto[];

  @ApiProperty({ example: 0 })
  total!: number;
}

/** La política de soporte de la empresa. */
export class SupportPolicyResponseDto {
  @ApiProperty({
    description:
      'Si el soporte puede abrir un acceso de emergencia sin aprobación',
  })
  emergencyAllowed!: boolean;

  @ApiProperty({ description: 'Si los pedidos de acceso se aprueban solos' })
  autoApprove!: boolean;
}
