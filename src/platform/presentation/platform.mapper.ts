import Decimal from 'decimal.js';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import type {
  FilaDeActividad,
  FilaDeAdmin,
  FilaDeEmpresa,
  FilaDeMetricas,
  FilaDeSesion,
} from '../infrastructure/platform-metrics.repository';
import {
  ActivityItemDto,
  CompanyAdminDto,
  CompanyMetricsDto,
  CompanyProfileDto,
  CompanySupportSessionDto,
} from './dto/platform-response.dto';

/** Pesos a 2 decimales, sumados con `decimal.js` (nunca con `number`). */
export function pesos(valores: ReadonlyArray<string | number>): number {
  return valores
    .reduce<Decimal>((acc, v) => acc.plus(new Decimal(v)), new Decimal(0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** Dólares a 6 decimales (el costo del lector se guarda así). */
export function dolares(valores: ReadonlyArray<string | number>): number {
  return valores
    .reduce<Decimal>((acc, v) => acc.plus(new Decimal(v)), new Decimal(0))
    .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
    .toNumber();
}

/** Las métricas vacías: una empresa sin pedidos ni gente. */
export function sinMetricas(): FilaDeMetricas {
  return {
    id: '',
    pedidos: 0,
    ventas: 0,
    facturacion: '0',
    choferes: 0,
    clientes: 0,
    ultima_actividad: null,
    soporte_activo: false,
    soporte_pendiente: 0,
  };
}

export class PlatformMapper {
  static metricas(f: FilaDeMetricas): CompanyMetricsDto {
    const dto = new CompanyMetricsDto();
    dto.orders = f.pedidos;
    dto.salesOrders = f.ventas;
    dto.revenue = pesos([f.facturacion]);
    dto.activeDrivers = f.choferes;
    dto.customers = f.clientes;
    return dto;
  }

  /** La suma de las métricas de varias empresas (el total del tablero). */
  static sumar(filas: readonly FilaDeMetricas[]): CompanyMetricsDto {
    const dto = new CompanyMetricsDto();
    dto.orders = filas.reduce((n, f) => n + f.pedidos, 0);
    dto.salesOrders = filas.reduce((n, f) => n + f.ventas, 0);
    dto.revenue = pesos(filas.map((f) => f.facturacion));
    dto.activeDrivers = filas.reduce((n, f) => n + f.choferes, 0);
    dto.customers = filas.reduce((n, f) => n + f.clientes, 0);
    return dto;
  }

  /** La empresa como cliente: sin teléfono, datos bancarios ni credenciales. */
  static empresa(f: FilaDeEmpresa): CompanyProfileDto {
    const dto = new CompanyProfileDto();
    dto.id = f.id;
    dto.name = f.name;
    dto.slug = f.slug;
    dto.legalName = f.legal_name;
    dto.taxId = f.tax_id;
    dto.contactEmail = f.email;
    dto.status = f.status as DistributorStatus;
    dto.ownedByPlatform = f.owned_by_platform;
    dto.plan = f.plan;
    dto.createdAt = new Date(f.created_at);
    dto.supportEmergencyAllowed = f.support_emergency_allowed;
    dto.supportAutoApprove = f.support_auto_approve;
    return dto;
  }

  static admin(f: FilaDeAdmin): CompanyAdminDto {
    const dto = new CompanyAdminDto();
    dto.userId = f.user_id;
    dto.name = f.full_name;
    dto.email = f.email;
    dto.staffRole = f.staff_role;
    dto.blocked = f.blocked;
    dto.lastLoginAt = f.last_login_at ? new Date(f.last_login_at) : null;
    return dto;
  }

  static sesion(f: FilaDeSesion): CompanySupportSessionDto {
    const fecha = (v: Date | null) => (v ? new Date(v) : null);
    const dto = new CompanySupportSessionDto();
    dto.id = f.id;
    dto.kind = f.kind;
    dto.status = f.status;
    dto.requestedByName = f.requested_by_name;
    dto.reason = f.reason;
    dto.requestedMinutes = Number(f.requested_minutes);
    dto.createdAt = new Date(f.created_at);
    dto.startedAt = fecha(f.started_at);
    dto.expiresAt = fecha(f.expires_at);
    dto.endedAt = fecha(f.ended_at);
    dto.endReason = f.end_reason;
    return dto;
  }

  /** `actorPhotoUrl`: la foto del actor ya firmada (el mapper no conoce S3). */
  static actividad(
    f: FilaDeActividad,
    actorPhotoUrl: string | null,
  ): ActivityItemDto {
    const dto = new ActivityItemDto();
    dto.id = f.id;
    dto.at = f.at;
    dto.kind = f.kind;
    dto.actorUserId = f.actor_user_id;
    dto.actorName = f.actor_name;
    dto.actorPhotoUrl = actorPhotoUrl;
    dto.actorRole = f.actor_role;
    dto.method = f.method;
    dto.resource = f.resource;
    dto.resourceId = f.resource_id;
    dto.path = f.path;
    dto.distributorId = f.distributor_id;
    dto.distributorName = f.distributor_name;
    dto.result = f.result;
    dto.statusCode = f.status_code;
    return dto;
  }
}
