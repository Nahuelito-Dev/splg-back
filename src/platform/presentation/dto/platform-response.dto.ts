import { ApiProperty } from '@nestjs/swagger';
import { DistributorStatus } from '../../../distributor/entities/distributor.entity';
import {
  ProcessHealth,
  ProcessName,
} from '../../../process-run/domain/process-catalog';

/**
 * Salidas del panel de plataforma (E3). Regla: ningún dato personal de
 * clientes ni choferes (teléfonos, DNI, correos), ni datos bancarios ni
 * credenciales de la empresa. Los únicos correos son los de las cuentas del
 * panel (administradores) y el de contacto de la empresa. Lo controla
 * `platform-openapi.spec.ts` sobre el documento de Swagger.
 */

export class PlatformRangeDto {
  @ApiProperty({ example: '2026-11-01', description: 'Primer día (inclusive)' })
  from!: string;

  @ApiProperty({ example: '2026-11-14', description: 'Último día (inclusive)' })
  to!: string;
}

/** Las métricas de una empresa en el período (sólo conteos y montos). */
export class CompanyMetricsDto {
  @ApiProperty({
    example: 182,
    description: 'Pedidos creados en el período (cualquier estado)',
  })
  orders!: number;

  @ApiProperty({
    example: 150,
    description:
      'Ventas: pedidos entregados y cobrados en el período (el mismo criterio que `GET /v2/reports/sales-summary` de la empresa)',
  })
  salesOrders!: number;

  @ApiProperty({
    example: 1234567.5,
    description:
      'Facturación: suma de los totales de las ventas del período, en pesos con 2 decimales (cuadra con `totalSales` del reporte de la empresa)',
  })
  revenue!: number;

  @ApiProperty({
    example: 7,
    description: 'Choferes habilitados y validados (sin los dados de baja)',
  })
  activeDrivers!: number;

  @ApiProperty({
    example: 320,
    description: 'Clientes vinculados a la empresa (sin los desvinculados)',
  })
  customers!: number;
}

export class CompanyListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Gas del Norte' })
  name!: string;

  @ApiProperty({ example: 'gas-del-norte' })
  slug!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Logo de la empresa: URL firmada de S3 de corta vigencia, o null si no tiene',
  })
  logoUrl!: string | null;

  @ApiProperty({ enum: DistributorStatus })
  status!: DistributorStatus;

  @ApiProperty({
    description:
      'Empresa propia de la plataforma: el administrador general la opera con `X-Distributor`, sin sesión de soporte',
  })
  ownedByPlatform!: boolean;

  @ApiProperty({ type: String, nullable: true, example: null })
  plan!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'Alta' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Última actividad: el pedido más nuevo o la última escritura de su gente en la API (sin las del administrador general)',
  })
  lastActivityAt!: Date | null;

  @ApiProperty({ type: CompanyMetricsDto })
  metrics!: CompanyMetricsDto;

  @ApiProperty({
    example: 0,
    description:
      'Procesos automáticos de la empresa atrasados, fallidos o trabados ahora',
  })
  processAlerts!: number;

  @ApiProperty({
    description: 'Si hay una sesión de soporte activa sobre la empresa',
  })
  supportSessionActive!: boolean;

  @ApiProperty({
    example: 0,
    description: 'Pedidos de acceso de soporte pendientes de aprobación',
  })
  supportRequestsPending!: number;
}

export class CompanyListResponseDto {
  @ApiProperty({ type: PlatformRangeDto })
  range!: PlatformRangeDto;

  @ApiProperty({ type: [CompanyListItemDto] })
  items!: CompanyListItemDto[];

  @ApiProperty({ example: 12, description: 'Empresas con ese filtro' })
  total!: number;
}

export class CompanyCountsDto {
  @ApiProperty({
    example: 12,
    description: 'Empresas vigentes (sin las dadas de baja)',
  })
  total!: number;

  @ApiProperty({ example: 9 })
  active!: number;

  @ApiProperty({ example: 1 })
  suspended!: number;
}

export class DocumentReadingTotalsDto {
  @ApiProperty({
    example: '2026-11',
    description: 'Mes calendario (hora argentina)',
  })
  month!: string;

  @ApiProperty({
    example: 412,
    description: 'Lecturas que llegaron al proveedor en el mes',
  })
  readings!: number;

  @ApiProperty({
    example: 3.284511,
    description: 'Costo en dólares (6 decimales)',
  })
  costUsd!: number;
}

export class ProcessTotalsDto {
  @ApiProperty({
    example: 2,
    description:
      'Procesos (por empresa y globales) atrasados, fallidos o trabados ahora',
  })
  alerts!: number;

  @ApiProperty({
    example: 5,
    description: 'Corridas fallidas en las últimas 24 horas',
  })
  failuresLast24h!: number;
}

export class SupportTotalsDto {
  @ApiProperty({ example: 1 })
  active!: number;

  @ApiProperty({ example: 0 })
  pending!: number;
}

export class PlatformOverviewResponseDto {
  @ApiProperty({ type: PlatformRangeDto })
  range!: PlatformRangeDto;

  @ApiProperty({ type: CompanyCountsDto })
  companies!: CompanyCountsDto;

  @ApiProperty({
    type: CompanyMetricsDto,
    description:
      'Suma de las métricas de todas las empresas vigentes: cuadra con la suma de `GET /v2/platform/companies`',
  })
  totals!: CompanyMetricsDto;

  @ApiProperty({
    type: DocumentReadingTotalsDto,
    description: 'Del mes en curso',
  })
  documentReading!: DocumentReadingTotalsDto;

  @ApiProperty({ type: ProcessTotalsDto })
  processes!: ProcessTotalsDto;

  @ApiProperty({ type: SupportTotalsDto })
  supportSessions!: SupportTotalsDto;

  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt!: Date;
}

/** La empresa como cliente de la plataforma: sin teléfono, datos bancarios ni credenciales. */
export class CompanyProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Gas del Norte' })
  name!: string;

  @ApiProperty({ example: 'gas-del-norte' })
  slug!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Gas del Norte S. A.' })
  legalName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '30712345678',
    description: 'CUIT',
  })
  taxId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'contacto@gasdelnorte.com.ar',
    description: 'Correo de contacto de la empresa (no de una persona)',
  })
  contactEmail!: string | null;

  @ApiProperty({ enum: DistributorStatus })
  status!: DistributorStatus;

  @ApiProperty({
    description:
      'Empresa propia de la plataforma: el administrador general la opera con `X-Distributor`, sin sesión de soporte',
  })
  ownedByPlatform!: boolean;

  @ApiProperty({ type: String, nullable: true })
  plan!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({
    description: 'La empresa permite el acceso de soporte de emergencia',
  })
  supportEmergencyAllowed!: boolean;

  @ApiProperty({
    description: 'La empresa aprueba sola los pedidos de acceso de soporte',
  })
  supportAutoApprove!: boolean;
}

/** Un administrador de la empresa: es una cuenta del panel, no un cliente. */
export class CompanyAdminDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Lucía Pérez' })
  name!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'lucia@gasdelnorte.com.ar',
  })
  email!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Administrador',
    description: 'Rol de personal (F37); `null` si no tiene uno asignado',
  })
  staffRole!: string | null;

  @ApiProperty({ description: 'Si la cuenta está bloqueada' })
  blocked!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt!: Date | null;
}

export class CompanyProcessDto {
  @ApiProperty({ enum: ProcessName })
  process!: ProcessName;

  @ApiProperty({ example: 'Recupero de envases' })
  title!: string;

  @ApiProperty({ enum: ProcessHealth })
  health!: ProcessHealth;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastRunAt!: Date | null;

  @ApiProperty({
    example: 0,
    description: 'Corridas fallidas en las últimas 24 horas',
  })
  failuresLast24h!: number;
}

export class CompanySupportSessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['consented', 'emergency'] })
  kind!: string;

  @ApiProperty({
    enum: [
      'pending',
      'rejected',
      'expired_request',
      'cancelled',
      'active',
      'ended',
      'revoked',
      'expired',
    ],
  })
  status!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Soporte Plataforma',
    description: 'Nombre del administrador general que la pidió',
  })
  requestedByName!: string | null;

  @ApiProperty({
    example: 'El tablero de despacho no muestra los pedidos de hoy',
  })
  reason!: string;

  @ApiProperty({ example: 60 })
  requestedMinutes!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['exit', 'revoked_by_company', 'revoked_by_platform', 'expired'],
  })
  endReason!: string | null;
}

export class CompanyDocumentReadingDto extends DocumentReadingTotalsDto {
  @ApiProperty({ description: 'Si la lectura automática está encendida' })
  enabled!: boolean;

  @ApiProperty({
    example: 20,
    description: 'Tope de gasto mensual configurado (USD)',
  })
  monthlyBudgetUsd!: number;
}

export class CompanyDetailResponseDto {
  @ApiProperty({ type: PlatformRangeDto })
  range!: PlatformRangeDto;

  @ApiProperty({ type: CompanyProfileDto })
  company!: CompanyProfileDto;

  @ApiProperty({ type: CompanyMetricsDto })
  metrics!: CompanyMetricsDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastActivityAt!: Date | null;

  @ApiProperty({
    type: CompanyDocumentReadingDto,
    description: 'Del mes en curso',
  })
  documentReading!: CompanyDocumentReadingDto;

  @ApiProperty({
    type: [CompanyProcessDto],
    description: 'Sólo los procesos de la empresa (sin los globales)',
  })
  processes!: CompanyProcessDto[];

  @ApiProperty({ type: [CompanyAdminDto] })
  admins!: CompanyAdminDto[];

  @ApiProperty({
    type: [CompanySupportSessionDto],
    description: 'Las últimas 10',
  })
  supportSessions!: CompanySupportSessionDto[];
}

export class PlatformProcessDto {
  @ApiProperty({ enum: ProcessName })
  process!: ProcessName;

  @ApiProperty({ example: 'Recupero de envases' })
  title!: string;

  @ApiProperty({ type: String, nullable: true, example: 'M5' })
  module!: string | null;

  @ApiProperty({
    description:
      'Si tiene corridas globales (una corrida recorre a todas las empresas)',
  })
  global!: boolean;

  @ApiProperty({
    example: 9,
    description: 'Cuántas empresas tienen corridas propias de este proceso',
  })
  companies!: number;

  @ApiProperty({ example: 3600, description: 'Cada cuánto tiene que correr' })
  expectedEverySeconds!: number;

  @ApiProperty({
    example: { ok: 8, failed: 1 },
    description:
      'Cuántas empresas (o la corrida global) hay en cada estado de salud',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  health!: Partial<Record<ProcessHealth, number>>;

  @ApiProperty({
    example: 1,
    description: 'Atrasados, fallidos o trabados ahora',
  })
  alerts!: number;

  @ApiProperty({
    example: 2,
    description: 'Corridas fallidas en las últimas 24 horas',
  })
  failuresLast24h!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastRunAt!: Date | null;
}

export class PlatformProcessesResponseDto {
  @ApiProperty({ type: [PlatformProcessDto] })
  items!: PlatformProcessDto[];

  @ApiProperty({ example: 1 })
  alerts!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt!: Date;
}

export class DocumentReadingUsageItemDto {
  @ApiProperty({ format: 'uuid' })
  distributorId!: string;

  @ApiProperty({ example: 'Gas del Norte' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Logo de la empresa: URL firmada de S3 de corta vigencia, o null si no tiene',
  })
  logoUrl!: string | null;

  @ApiProperty({ example: 41 })
  readings!: number;

  @ApiProperty({ example: 0.318204 })
  costUsd!: number;

  @ApiProperty({ example: 20 })
  monthlyBudgetUsd!: number;

  @ApiProperty({ description: 'Si la lectura automática está encendida' })
  enabled!: boolean;

  @ApiProperty({
    example: 1.6,
    description: 'Porcentaje del tope usado (2 decimales)',
  })
  budgetUsedPct!: number;
}

export class DocumentReadingUsageResponseDto {
  @ApiProperty({ example: '2026-11' })
  month!: string;

  @ApiProperty({
    type: [DocumentReadingUsageItemDto],
    description: 'Las empresas vigentes, de mayor a menor costo',
  })
  items!: DocumentReadingUsageItemDto[];

  @ApiProperty({ example: 412 })
  totalReadings!: number;

  @ApiProperty({ example: 3.284511 })
  totalCostUsd!: number;
}

export class ActivityItemDto {
  @ApiProperty({ example: '6f1c…' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  at!: Date;

  @ApiProperty({
    enum: ['request', 'login'],
    description: 'Una escritura en la API o un ingreso al panel',
  })
  kind!: 'request' | 'login';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorUserId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Soporte Plataforma' })
  actorName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Foto de perfil de quien lo hizo: URL firmada de S3 de corta vigencia, o null si no tiene (o no hay actor)',
  })
  actorPhotoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'super_admin' })
  actorRole!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'PATCH' })
  method!: string | null;

  @ApiProperty({
    example: 'distributor',
    description: 'Recurso (primer tramo de la ruta)',
  })
  resource!: string;

  @ApiProperty({ type: String, nullable: true })
  resourceId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/api/distributor/:id',
    description: 'Patrón de la ruta (sin valores)',
  })
  path!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  distributorId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Gas del Norte' })
  distributorName!: string | null;

  @ApiProperty({ enum: ['success', 'failure'] })
  result!: string;

  @ApiProperty({ example: 200 })
  statusCode!: number;
}

export class ActivityListResponseDto {
  @ApiProperty({ type: [ActivityItemDto] })
  items!: ActivityItemDto[];

  @ApiProperty({ example: 57 })
  total!: number;
}
