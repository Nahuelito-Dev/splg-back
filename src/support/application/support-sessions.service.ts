import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  EntityManager,
  FindOptionsWhere,
  LessThanOrEqual,
  MoreThanOrEqual,
} from 'typeorm';
import { AuditActionTypeId } from '../../audit/entities/audit-action-type.entity';
import { AuditoriaDeDatos } from '../../audit/data/auditoria-de-datos';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { codigoSqlDelError } from '../../common/errors/db-exceptions';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import { DistributorService } from '../../distributor/distributor.service';
import {
  SupportEndReason,
  SupportSessionKind,
  SupportSessionStatus,
} from '../domain/support-session.enums';
import {
  AccionDeSoporte,
  finDeLaSesion,
  siguienteEstado,
  VIGENCIA_DE_LA_SOLICITUD_MS,
  validarDuracion,
} from '../domain/support-session.machine';
import { SupportAccess } from '../entities/support-access.entity';
import { SupportSession } from '../entities/support-session.entity';
import { CreateSupportSessionDto } from '../presentation/dto/create-support-session.dto';
import { EndSupportSessionDto } from '../presentation/dto/end-support-session.dto';
import {
  QuerySupportSessionsDto,
  SupportPaginationDto,
} from '../presentation/dto/query-support-sessions.dto';
import { SupportSessionCache } from './support-session.cache';
import {
  bloquearSesion,
  cierre,
  transicionar,
} from './support-session.transitions';
import { SupportNotices } from './support-notices';
import { SupportEndedNotice } from './support-ended.notice';

const UNICO_VIOLADO = '23505';

/** Relaciones que necesita el DTO de salida. */
export const RELACIONES_DE_LA_SESION = {
  distributor: true,
  requester: true,
  decider: true,
  ender: true,
} as const;

export const NOTA_DE_AUTOAPROBACION =
  'Aprobada automáticamente por la política de la empresa';

export function yaTieneUnaActiva(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya tenés una sesión de soporte activa: salí de esa antes de pedir otra',
    CODIGOS_DE_ERROR.SUPPORT_SESSION_ALREADY_ACTIVE,
  );
}

function yaHayUnaPendiente(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya hay un pedido de soporte pendiente para esa empresa',
    CODIGOS_DE_ERROR.SUPPORT_REQUEST_ALREADY_PENDING,
  );
}

function sesionNoEncontrada(): NotFoundException {
  return new NotFoundException('No existe esa sesión de soporte');
}

/**
 * Modo soporte, lado de la plataforma (`/v2/support-sessions`): el
 * administrador general pide acceso a una empresa, consulta la suya, ve el
 * historial y sale (o retira el pedido, o corta la de otro).
 */
@Injectable()
export class SupportSessionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly distribuidoras: DistributorService,
    private readonly cache: SupportSessionCache,
    private readonly avisos: SupportNotices,
    private readonly fin: SupportEndedNotice,
  ) {}

  async pedir(
    userId: string,
    dto: CreateSupportSessionDto,
    ahora: Date = new Date(),
  ): Promise<SupportSession> {
    const empresa = await this.distribuidoras.findOne(dto.distributorId);
    if (empresa.status !== DistributorStatus.ACTIVE) {
      throw conCodigo(
        ConflictException,
        409,
        'La empresa está suspendida: no se puede pedir acceso de soporte',
        CODIGOS_DE_ERROR.SUPPORT_COMPANY_SUSPENDED,
      );
    }
    const tipo = dto.emergency
      ? SupportSessionKind.EMERGENCY
      : SupportSessionKind.CONSENTED;
    validarDuracion(dto.minutes, tipo);
    if (
      tipo === SupportSessionKind.EMERGENCY &&
      !empresa.supportEmergencyAllowed
    ) {
      throw conCodigo(
        ForbiddenException,
        403,
        'La empresa no permite accesos de emergencia: pedí acceso y esperá su aprobación',
        CODIGOS_DE_ERROR.SUPPORT_EMERGENCY_DISABLED,
      );
    }
    const entraYa =
      tipo === SupportSessionKind.EMERGENCY || empresa.supportAutoApprove;

    const sesion = await this.dataSource
      .transaction(async (manager) => {
        await this.assertSinSesionesEnConflicto(
          manager,
          userId,
          dto.distributorId,
        );
        const nueva = manager.getRepository(SupportSession).create({
          distributorId: dto.distributorId,
          requestedBy: userId,
          kind: tipo,
          status: entraYa
            ? siguienteEstado(
                SupportSessionStatus.PENDING,
                AccionDeSoporte.APROBAR,
              )
            : SupportSessionStatus.PENDING,
          reason: dto.reason,
          ticketRef: dto.ticketRef ?? null,
          scope: [...new Set(dto.scope)],
          requestedMinutes: dto.minutes,
          requestExpiresAt:
            tipo === SupportSessionKind.CONSENTED
              ? new Date(ahora.getTime() + VIGENCIA_DE_LA_SOLICITUD_MS)
              : null,
          decidedBy: null,
          decidedAt:
            entraYa && tipo === SupportSessionKind.CONSENTED ? ahora : null,
          decisionNote:
            entraYa && tipo === SupportSessionKind.CONSENTED
              ? NOTA_DE_AUTOAPROBACION
              : null,
          startedAt: entraYa ? ahora : null,
          expiresAt: entraYa ? finDeLaSesion(ahora, dto.minutes) : null,
          endedAt: null,
          endedBy: null,
          endReason: null,
        });
        return manager.getRepository(SupportSession).save(nueva);
      })
      .catch((error: unknown) => {
        throw this.traducirUnico(error);
      });

    if (tipo === SupportSessionKind.EMERGENCY) this.avisos.emergencia(sesion);
    else if (entraYa) this.avisos.autoaprobado(sesion);
    else this.avisos.pedido(sesion);
    return this.ficha(sesion.supportSessionId);
  }

  /**
   * La sesión activa (en plazo) del usuario o, si no hay, su pedido pendiente
   * más nuevo (en plazo). `null` si no tiene ninguna.
   */
  async actual(userId: string): Promise<SupportSession | null> {
    const filas: Array<{ id: string }> = await this.dataSource.query(
      `SELECT "support_session_id" AS id FROM "support_session"
        WHERE "requested_by" = $1
          AND (("status" = 'active' AND "expires_at" > now())
            OR ("status" = 'pending' AND "request_expires_at" > now()))
        ORDER BY ("status" = 'active') DESC, "created_at" DESC
        LIMIT 1`,
      [userId],
    );
    return filas[0] ? this.ficha(filas[0].id) : null;
  }

  async listar(
    query: QuerySupportSessionsDto,
  ): Promise<{ items: SupportSession[]; total: number }> {
    const desde = query.from ? new Date(query.from) : null;
    const hasta = query.to ? new Date(query.to) : null;
    if (desde && hasta && desde > hasta) {
      throw new BadRequestException(
        'La fecha «desde» no puede ser posterior a la fecha «hasta»',
      );
    }
    const where: FindOptionsWhere<SupportSession> = {};
    if (query.status) where.status = query.status;
    if (query.distributorId) where.distributorId = query.distributorId;
    if (query.requestedBy) where.requestedBy = query.requestedBy;
    if (desde && hasta) where.createdAt = Between(desde, hasta);
    else if (desde) where.createdAt = MoreThanOrEqual(desde);
    else if (hasta) where.createdAt = LessThanOrEqual(hasta);
    const [items, total] = await this.dataSource
      .getRepository(SupportSession)
      .findAndCount({
        where,
        relations: RELACIONES_DE_LA_SESION,
        order: { createdAt: 'DESC', supportSessionId: 'ASC' },
        take: query.limit,
        skip: query.offset,
      });
    return { items, total };
  }

  async ficha(id: string, distributorId?: string): Promise<SupportSession> {
    const sesion = await this.dataSource.getRepository(SupportSession).findOne({
      where: distributorId
        ? { supportSessionId: id, distributorId }
        : { supportSessionId: id },
      relations: RELACIONES_DE_LA_SESION,
    });
    if (!sesion) throw sesionNoEncontrada();
    return sesion;
  }

  /** Lo que se miró en la sesión (lo registra la etapa E2). */
  async accesos(
    id: string,
    paginacion: SupportPaginationDto,
    distributorId?: string,
  ): Promise<{ items: SupportAccess[]; total: number }> {
    await this.ficha(id, distributorId);
    const [items, total] = await this.dataSource
      .getRepository(SupportAccess)
      .findAndCount({
        where: { supportSessionId: id },
        order: { at: 'DESC', supportAccessId: 'DESC' },
        take: paginacion.limit,
        skip: paginacion.offset,
      });
    return { items, total };
  }

  /**
   * `DELETE /v2/support-sessions/:id`. La propia: activa → `ended` (salir),
   * pendiente → `cancelled` (retirar). La de otro administrador general:
   * activa → `revoked` (`revoked_by_platform`), pendiente → `cancelled`; en
   * los dos casos con motivo, que queda en la auditoría. Una activa ya vencida
   * se cierra como `expired`. Terminada → 409.
   */
  async terminar(
    userId: string,
    id: string,
    dto: EndSupportSessionDto,
    ahora: Date = new Date(),
  ): Promise<void> {
    const terminada = await this.dataSource.transaction(async (manager) => {
      const sesion = await bloquearSesion(manager, id);
      if (!sesion) throw sesionNoEncontrada();
      const propia = sesion.requestedBy === userId;
      if (!propia && !dto.reason) {
        throw new BadRequestException(
          'Para cortar la sesión de soporte de otra persona indicá el motivo',
        );
      }
      if (sesion.status === SupportSessionStatus.PENDING) {
        await transicionar(manager, sesion, AccionDeSoporte.RETIRAR, {
          decisionNote: propia ? null : (dto.reason ?? null),
        });
      } else if (
        sesion.status === SupportSessionStatus.ACTIVE &&
        sesion.expiresAt &&
        sesion.expiresAt.getTime() <= ahora.getTime()
      ) {
        await transicionar(
          manager,
          sesion,
          AccionDeSoporte.VENCER,
          cierre(SupportEndReason.EXPIRED, null, sesion.expiresAt),
        );
      } else if (propia) {
        await transicionar(
          manager,
          sesion,
          AccionDeSoporte.SALIR,
          cierre(SupportEndReason.EXIT, userId, ahora),
        );
      } else {
        await transicionar(
          manager,
          sesion,
          AccionDeSoporte.REVOCAR,
          cierre(SupportEndReason.REVOKED_BY_PLATFORM, userId, ahora),
        );
      }
      if (!propia && dto.reason) {
        await AuditoriaDeDatos.registrar(manager, {
          actionTypeId: AuditActionTypeId.UPDATE,
          entity: 'SupportSession',
          recordId: sesion.supportSessionId,
          distributorId: sesion.distributorId,
          details: [{ field: 'endNote', oldValue: null, newValue: dto.reason }],
        });
      }
      return sesion;
    });
    await this.cache.olvidar(id);
    this.fin.avisar(terminada);
  }

  private async assertSinSesionesEnConflicto(
    manager: EntityManager,
    userId: string,
    distributorId: string,
  ): Promise<void> {
    const filas: Array<{ status: SupportSessionStatus }> = await manager.query(
      `SELECT "status" FROM "support_session"
        WHERE "requested_by" = $1
          AND ("status" = 'active' OR ("status" = 'pending' AND "distributor_id" = $2))`,
      [userId, distributorId],
    );
    if (filas.some((f) => f.status === SupportSessionStatus.ACTIVE)) {
      throw yaTieneUnaActiva();
    }
    if (filas.length > 0) throw yaHayUnaPendiente();
  }

  /** Dos pedidos simultáneos: el único parcial de la base frena al segundo. */
  private traducirUnico(error: unknown): unknown {
    if (codigoSqlDelError(error) !== UNICO_VIOLADO) return error;
    const restriccion =
      (
        error as {
          constraint?: unknown;
          driverError?: { constraint?: unknown };
        }
      ).driverError?.constraint ??
      (error as { constraint?: unknown }).constraint;
    if (restriccion === 'UQ_support_session_activa') return yaTieneUnaActiva();
    if (restriccion === 'UQ_support_session_pendiente')
      return yaHayUnaPendiente();
    return error;
  }
}
