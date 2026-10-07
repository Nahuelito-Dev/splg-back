import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { Audit } from '../entities/audit.entity';
import { AuditDetail } from '../entities/audit-detail.entity';
import { AuditActionType } from '../entities/audit-action-type.entity';
import {
  AuditActionTypeDto,
  AuditEntriesPageDto,
  AuditEntryDto,
  QueryAuditEntriesDto,
} from './data-audit.dto';
import { DataAuditMapper } from './data-audit.mapper';

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
    const where: FindOptionsWhere<Audit> = {};
    if (distributorId) where.distributorId = distributorId;
    if (filtros.entity) where.entity = filtros.entity;
    if (filtros.recordId) where.recordId = filtros.recordId;
    if (filtros.userId) where.userId = filtros.userId;
    if (filtros.actionType) where.actionTypeId = filtros.actionType;
    if (filtros.from && filtros.to) {
      where.createdAt = Between(filtros.from, filtros.to);
    } else if (filtros.from) {
      where.createdAt = MoreThanOrEqual(filtros.from);
    } else if (filtros.to) {
      where.createdAt = LessThanOrEqual(filtros.to);
    }
    const [filas, total] = await this.audits.findAndCount({
      where,
      relations: { actionType: true, user: true },
      withDeleted: true,
      order: { createdAt: 'DESC', auditId: 'ASC' },
      take: filtros.limit,
      skip: (filtros.page - 1) * filtros.limit,
    });
    const detalles = await this.detailsOf(filas.map((a) => a.auditId));
    return {
      data: filas.map((a) =>
        DataAuditMapper.toDto(a, detalles.get(a.auditId) ?? []),
      ),
      total,
    };
  }

  async findOne(
    auditId: string,
    distributorId: string | null,
  ): Promise<AuditEntryDto> {
    const where: FindOptionsWhere<Audit> = { auditId };
    if (distributorId) where.distributorId = distributorId;
    const fila = await this.audits.findOne({
      where,
      relations: { actionType: true, user: true },
      withDeleted: true,
    });
    if (!fila) throw new NotFoundException('Auditoría no encontrada');
    const detalles = await this.detailsOf([auditId]);
    return DataAuditMapper.toDto(fila, detalles.get(auditId) ?? []);
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
