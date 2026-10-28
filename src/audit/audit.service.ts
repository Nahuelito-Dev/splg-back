import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { ConsultarAuditoriaDto } from './dto/consultar-auditoria.dto';
import { errorMessage } from '../common/errors/error-message';

/** Lo que se registra de una operación (sin id ni fecha: los pone la base). */
export type NuevoAsiento = Omit<
  AuditLog,
  'auditId' | 'createdAt' | 'distributor' | 'actor'
>;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
  ) {}

  /**
   * Guarda un asiento (CU-153). No lanza: si la base no lo acepta, la
   * operación del usuario ya ocurrió y no se deshace; queda en el log con
   * todos los datos para reconstruirlo.
   */
  async registrar(asiento: NuevoAsiento): Promise<void> {
    try {
      await this.auditRepository.save(this.auditRepository.create(asiento));
    } catch (error) {
      this.logger.error(
        `No se pudo registrar la auditoría de ${asiento.httpMethod} ${asiento.path}: ${errorMessage(error)}`,
        JSON.stringify(asiento),
      );
    }
  }

  /**
   * Consulta del registro (CU-152), del más reciente al más viejo. Con una
   * distribuidora en contexto sólo ve lo de ella; sin contexto (super admin
   * sin "ver como"), todo.
   */
  async consultar(
    filtros: ConsultarAuditoriaDto,
    distributorId: string | null,
  ): Promise<{ items: AuditLog[]; total: number }> {
    const where: FindOptionsWhere<AuditLog> = {};
    if (distributorId) where.distributorId = distributorId;
    if (filtros.actorUserId) where.actorUserId = filtros.actorUserId;
    if (filtros.resource) where.resource = filtros.resource;
    if (filtros.resourceId) where.resourceId = filtros.resourceId;
    if (filtros.result) where.result = filtros.result;
    if (filtros.desde && filtros.hasta) {
      where.createdAt = Between(filtros.desde, filtros.hasta);
    } else if (filtros.desde) {
      where.createdAt = MoreThanOrEqual(filtros.desde);
    } else if (filtros.hasta) {
      where.createdAt = LessThanOrEqual(filtros.hasta);
    }
    const [items, total] = await this.auditRepository.findAndCount({
      where,
      order: { createdAt: 'DESC', auditId: 'ASC' },
      take: filtros.limit,
      skip: filtros.offset,
    });
    return { items, total };
  }
}
