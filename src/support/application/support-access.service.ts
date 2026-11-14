import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, In } from 'typeorm';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { DistributorService } from '../../distributor/distributor.service';
import { SupportEndReason } from '../domain/support-session.enums';
import {
  AccionDeSoporte,
  assertAprobable,
  finDeLaSesion,
  resolverAprobacion,
} from '../domain/support-session.machine';
import { SupportSession } from '../entities/support-session.entity';
import { ApproveSupportAccessDto } from '../presentation/dto/approve-support-access.dto';
import { QuerySupportAccessDto } from '../presentation/dto/query-support-sessions.dto';
import { RejectSupportAccessDto } from '../presentation/dto/reject-support-access.dto';
import { UpdateSupportPolicyDto } from '../presentation/dto/update-support-policy.dto';
import { SupportSessionCache } from './support-session.cache';
import { SupportEndedNotice } from './support-ended.notice';
import {
  bloquearSesion,
  cierre,
  transicionar,
} from './support-session.transitions';
import {
  RELACIONES_DE_LA_SESION,
  SupportSessionsService,
  yaTieneUnaActiva,
} from './support-sessions.service';

const UNICO_VIOLADO = '23505';

/**
 * Modo soporte, lado de la empresa (`/v2/support-access`): el admin ve los
 * pedidos y sesiones de SU distribuidora (otra es 404), aprueba (acortando o
 * achicando), rechaza, revoca y fija la política (emergencia, autoaprobación).
 */
@Injectable()
export class SupportAccessService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sesiones: SupportSessionsService,
    private readonly distribuidoras: DistributorService,
    private readonly cache: SupportSessionCache,
    private readonly fin: SupportEndedNotice,
  ) {}

  /**
   * Pendientes primero; después, de la más nueva a la más vieja. El orden por
   * prioridad no lo arma TypeORM con la paginación y las relaciones: primero se
   * eligen los ids de la página y después se cargan.
   */
  async listar(
    distributorId: string,
    query: QuerySupportAccessDto,
  ): Promise<{ items: SupportSession[]; total: number }> {
    const where: FindOptionsWhere<SupportSession> = { distributorId };
    if (query.status) where.status = query.status;
    const parametros: unknown[] = [distributorId, query.limit, query.offset];
    if (query.status) parametros.push(query.status);
    const pagina: Array<{ id: string }> = await this.dataSource.query(
      `SELECT "support_session_id" AS id FROM "support_session"
        WHERE "distributor_id" = $1 ${query.status ? 'AND "status" = $4' : ''}
        ORDER BY ("status" = 'pending') DESC, "created_at" DESC, "support_session_id"
        LIMIT $2 OFFSET $3`,
      parametros,
    );
    const repo = this.dataSource.getRepository(SupportSession);
    const total = await repo.count({ where });
    if (pagina.length === 0) return { items: [], total };
    const ids = pagina.map((f) => f.id);
    const filas = await repo.find({
      where: { supportSessionId: In(ids) },
      relations: RELACIONES_DE_LA_SESION,
    });
    const porId = new Map(filas.map((f) => [f.supportSessionId, f]));
    const items = ids
      .map((id) => porId.get(id))
      .filter((f): f is SupportSession => f !== undefined);
    return { items, total };
  }

  async aprobar(
    distributorId: string,
    adminUserId: string,
    id: string,
    dto: ApproveSupportAccessDto,
    ahora: Date = new Date(),
  ): Promise<SupportSession> {
    await this.dataSource
      .transaction(async (manager) => {
        const sesion = await this.bloquearDeLaEmpresa(
          manager,
          id,
          distributorId,
        );
        assertAprobable(sesion.status, sesion.requestExpiresAt, ahora);
        const aprobado = resolverAprobacion(
          { minutos: sesion.requestedMinutes, alcance: sesion.scope },
          { minutos: dto.minutes, alcance: dto.scope },
        );
        await transicionar(manager, sesion, AccionDeSoporte.APROBAR, {
          scope: [...aprobado.alcance],
          decidedBy: adminUserId,
          decidedAt: ahora,
          decisionNote: dto.note ?? null,
          startedAt: ahora,
          expiresAt: finDeLaSesion(ahora, aprobado.minutos),
        });
      })
      .catch((error: unknown) => {
        // El que pidió ya tiene otra sesión activa (único parcial de la base).
        if (codigoSqlDelError(error) === UNICO_VIOLADO)
          throw yaTieneUnaActiva();
        throw error;
      });
    return this.sesiones.ficha(id, distributorId);
  }

  async rechazar(
    distributorId: string,
    adminUserId: string,
    id: string,
    dto: RejectSupportAccessDto,
    ahora: Date = new Date(),
  ): Promise<SupportSession> {
    await this.dataSource.transaction(async (manager) => {
      const sesion = await this.bloquearDeLaEmpresa(manager, id, distributorId);
      await transicionar(manager, sesion, AccionDeSoporte.RECHAZAR, {
        decidedBy: adminUserId,
        decidedAt: ahora,
        decisionNote: dto.note ?? null,
      });
    });
    return this.sesiones.ficha(id, distributorId);
  }

  /** Corta una sesión activa (también las de emergencia); vale en la request siguiente. */
  async revocar(
    distributorId: string,
    adminUserId: string,
    id: string,
    ahora: Date = new Date(),
  ): Promise<SupportSession> {
    const revocada = await this.dataSource.transaction(async (manager) => {
      const sesion = await this.bloquearDeLaEmpresa(manager, id, distributorId);
      return transicionar(
        manager,
        sesion,
        AccionDeSoporte.REVOCAR,
        cierre(SupportEndReason.REVOKED_BY_COMPANY, adminUserId, ahora),
      );
    });
    await this.cache.olvidar(id);
    this.fin.avisar(revocada);
    return this.sesiones.ficha(id, distributorId);
  }

  politica(
    distributorId: string,
  ): Promise<{ emergencyAllowed: boolean; autoApprove: boolean }> {
    return this.distribuidoras.politicaDeSoporte(distributorId);
  }

  actualizarPolitica(
    distributorId: string,
    dto: UpdateSupportPolicyDto,
  ): Promise<{ emergencyAllowed: boolean; autoApprove: boolean }> {
    return this.distribuidoras.actualizarPoliticaDeSoporte(distributorId, dto);
  }

  private async bloquearDeLaEmpresa(
    manager: Parameters<typeof bloquearSesion>[0],
    id: string,
    distributorId: string,
  ): Promise<SupportSession> {
    const sesion = await bloquearSesion(manager, id, distributorId);
    if (!sesion) {
      throw new NotFoundException('No existe esa sesión de soporte');
    }
    return sesion;
  }
}
