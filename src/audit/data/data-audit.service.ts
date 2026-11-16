import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Raw,
  Repository,
} from 'typeorm';
import { Audit } from '../entities/audit.entity';
import { AuditDetail } from '../entities/audit-detail.entity';
import { AuditActionType } from '../entities/audit-action-type.entity';
import {
  AuditActionTypeDto,
  AuditEntriesPageDto,
  AuditEntriesPageV2Dto,
  AuditEntryDto,
  AuditEntryV2Dto,
  OrigenDeAuditoria,
  QueryAuditEntriesDto,
  QueryAuditEntriesV2Dto,
} from './data-audit.dto';
import { APP_DE_LA_API } from './audit-origen';
import { DataAuditMapper } from './data-audit.mapper';

/**
 * El filtro `origin` como condición sobre la columna `source` (puede mirar las
 * demás columnas de la fila). Mismo criterio que `DataAuditMapper.origenDe`.
 */
function condicionDeOrigen(origen: OrigenDeAuditoria) {
  return Raw((alias) => {
    // `alias` llega como `Audit.source`: las hermanas se nombran por propiedad.
    const col = (c: string) => `${alias.replace(/source$/, '')}${c}`;
    const directo = `${alias} = 'db' AND ${col('appName')} IS DISTINCT FROM '${APP_DE_LA_API}'`;
    if (origen === 'user') return `${col('userId')} IS NOT NULL`;
    if (origen === 'direct') return `${col('userId')} IS NULL AND ${directo}`;
    return `${col('userId')} IS NULL AND NOT (${directo})`;
  });
}

/** Consulta de la auditoría de datos (Auditoria, DetalleAuditoria). */
@Injectable()
export class DataAuditService {
  constructor(
    @InjectRepository(Audit) private readonly audits: Repository<Audit>,
    @InjectRepository(AuditDetail)
    private readonly details: Repository<AuditDetail>,
    @InjectRepository(AuditActionType)
    private readonly actionTypes: Repository<AuditActionType>,
  ) {}

  /**
   * Del más reciente al más viejo. Con distribuidora en contexto sólo se ve lo
   * de ella; el super admin sin "ver como" ve todo (incluso lo sin tenant).
   */
  async findAll(
    filtros: QueryAuditEntriesDto,
    distributorId: string | null,
  ): Promise<AuditEntriesPageDto> {
    const { filas, detalles, total } = await this.buscar(
      filtros,
      distributorId,
    );
    return {
      data: filas.map((a) =>
        DataAuditMapper.toDto(a, detalles.get(a.auditId) ?? []),
      ),
      total,
    };
  }

  /** Igual que `findAll`, con `source`, `tableName`, `dbUser`, `appName` y el filtro `origin`. */
  async findAllV2(
    filtros: QueryAuditEntriesV2Dto,
    distributorId: string | null,
  ): Promise<AuditEntriesPageV2Dto> {
    const { filas, detalles, total } = await this.buscar(
      filtros,
      distributorId,
    );
    return {
      data: filas.map((a) =>
        DataAuditMapper.toDtoV2(a, detalles.get(a.auditId) ?? []),
      ),
      total,
    };
  }

  private async buscar(
    filtros: QueryAuditEntriesV2Dto,
    distributorId: string | null,
  ): Promise<{
    filas: Audit[];
    detalles: Map<string, AuditDetail[]>;
    total: number;
  }> {
    // Sin distribuidora (el super admin fuera de soporte) la versión de
    // plataforma: sólo los asientos sin distribuidora. El historial de un
    // pedido es siempre de una empresa: ahí no hay nada que ver.
    if (!distributorId && filtros.orderId) {
      return { filas: [], detalles: new Map(), total: 0 };
    }
    const where: FindOptionsWhere<Audit> = {};
    if (!distributorId) where.distributorId = IsNull();
    else if (!filtros.orderId) where.distributorId = distributorId;
    if (filtros.entity) where.entity = filtros.entity;
    if (filtros.recordId) where.recordId = filtros.recordId;
    if (filtros.userId) where.userId = filtros.userId;
    if (filtros.actionType) where.actionTypeId = filtros.actionType;
    if (filtros.origin) where.source = condicionDeOrigen(filtros.origin);
    if (filtros.from && filtros.to) {
      where.createdAt = Between(filtros.from, filtros.to);
    } else if (filtros.from) {
      where.createdAt = MoreThanOrEqual(filtros.from);
    } else if (filtros.to) {
      where.createdAt = LessThanOrEqual(filtros.to);
    }
    const condiciones = filtros.orderId
      ? this.delPedido(filtros.orderId, where, distributorId, filtros.entity)
      : where;
    // Un arreglo vacío de condiciones en TypeORM no filtra nada: sería todo.
    if (Array.isArray(condiciones) && condiciones.length === 0) {
      return { filas: [], detalles: new Map(), total: 0 };
    }
    const [filas, total] = await this.audits.findAndCount({
      where: condiciones,
      relations: { actionType: true, user: true },
      withDeleted: true,
      order: { createdAt: 'DESC', auditId: 'ASC' },
      take: filtros.limit,
      skip: (filtros.page - 1) * filtros.limit,
    });
    const detalles = await this.detailsOf(filas.map((a) => a.auditId));
    return { filas, detalles, total };
  }

  /**
   * Historial de un pedido: su asiento (`Order`) y los de sus renglones y
   * pagos, que apuntan al pedido por el campo `orderId` de su detalle (en el
   * valor nuevo, o en el anterior si es una baja física). El
   * renglón no tiene distribuidora propia (toma la del request), así que el
   * aislamiento de lo hijo se decide por el pedido: se ven sólo si el
   * pedido tiene asientos de la distribuidora en contexto. `entity` y
   * `recordId` siguen filtrando dentro del historial (el de un renglón o un pago;
   * el del pedido es el propio `orderId`).
   */
  private delPedido(
    orderId: string,
    base: FindOptionsWhere<Audit>,
    distributorId: string | null,
    entity?: string,
  ): FindOptionsWhere<Audit>[] {
    const hijos = ['OrderItem', 'Payment'];
    const filas: FindOptionsWhere<Audit>[] = [];
    const pidePedido = !base.recordId || base.recordId === orderId;
    if ((!entity || entity === 'Order') && pidePedido) {
      filas.push({
        ...base,
        entity: 'Order',
        recordId: orderId,
        ...(distributorId && { distributorId }),
      });
    }
    if (!entity || hijos.includes(entity)) {
      const delTenant = distributorId
        ? ` AND EXISTS (SELECT 1 FROM audit o WHERE o.entity = 'Order' AND o.record_id = :orderId AND o.distributor_id = :tenant)`
        : '';
      filas.push({
        ...base,
        entity: entity ?? In(hijos),
        auditId: Raw(
          (alias) =>
            `${alias} IN (SELECT audit_id FROM audit_detail WHERE field = 'orderId' AND (new_value = :orderId OR old_value = :orderId))${delTenant}`,
          { orderId, tenant: distributorId },
        ),
      });
    }
    return filas;
  }

  async findOne(
    auditId: string,
    distributorId: string | null,
  ): Promise<AuditEntryDto> {
    const { fila, detalles } = await this.buscarUna(auditId, distributorId);
    return DataAuditMapper.toDto(fila, detalles);
  }

  async findOneV2(
    auditId: string,
    distributorId: string | null,
  ): Promise<AuditEntryV2Dto> {
    const { fila, detalles } = await this.buscarUna(auditId, distributorId);
    return DataAuditMapper.toDtoV2(fila, detalles);
  }

  private async buscarUna(
    auditId: string,
    distributorId: string | null,
  ): Promise<{ fila: Audit; detalles: AuditDetail[] }> {
    const where: FindOptionsWhere<Audit> = {
      auditId,
      distributorId: distributorId ?? IsNull(),
    };
    const fila = await this.audits.findOne({
      where,
      relations: { actionType: true, user: true },
      withDeleted: true,
    });
    if (!fila) throw new NotFoundException('Auditoría no encontrada');
    const detalles = await this.detailsOf([auditId]);
    return { fila, detalles: detalles.get(auditId) ?? [] };
  }

  async findActionTypes(): Promise<AuditActionTypeDto[]> {
    const filas = await this.actionTypes.find({
      order: { actionTypeId: 'ASC' },
    });
    return filas.map((t) => DataAuditMapper.actionTypeToDto(t));
  }

  private async detailsOf(
    auditIds: string[],
  ): Promise<Map<string, AuditDetail[]>> {
    const porAuditoria = new Map<string, AuditDetail[]>();
    if (auditIds.length === 0) return porAuditoria;
    const filas = await this.details.find({
      where: { auditId: In(auditIds) },
      order: { field: 'ASC' },
    });
    for (const d of filas) {
      const lista = porAuditoria.get(d.auditId) ?? [];
      lista.push(d);
      porAuditoria.set(d.auditId, lista);
    }
    return porAuditoria;
  }
}
