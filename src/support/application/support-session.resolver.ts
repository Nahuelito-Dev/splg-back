import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import {
  soporteInexistente,
  soporteTerminado,
} from '../../common/errors/soporte';
import type { SesionDeSoporteEnCurso } from '../../common/types/sesion-de-soporte';
import {
  SupportEndReason,
  SupportSessionStatus,
} from '../domain/support-session.enums';
import { AccionDeSoporte } from '../domain/support-session.machine';
import { SupportSessionCache } from './support-session.cache';
import { SupportEndedNotice } from './support-ended.notice';
import {
  bloquearSesion,
  cierre,
  transicionar,
} from './support-session.transitions';

/** Un uuid canónico: lo demás ni se busca. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FilaDeSesion {
  id: string;
  requested_by: string;
  distributor_id: string;
  status: SupportSessionStatus;
  scope: string[];
  expires_at: Date | null;
  vigente: boolean | null;
  distributor_status: DistributorStatus;
  distributor_baja: boolean;
}

/**
 * Valida el `X-Support-Session` del administrador general (lo llama
 * `AuthGuard`) y devuelve la sesión en curso, que fija el tenant de la request.
 *
 *  - Inexistente, mal formada o de otro administrador → 404 `SUPPORT_SESSION_NOT_FOUND`.
 *  - Pendiente, vencida, finalizada o revocada → 403 `SUPPORT_SESSION_ENDED`.
 *  - Empresa suspendida o dada de baja durante la sesión → la cierra
 *    (`revoked_by_platform`) y 403 `SUPPORT_SESSION_ENDED`.
 *
 * El vencimiento se compara con el reloj de la base al cargarla; la caché
 * (`SupportSessionCache`) nunca dura más de lo que le falta a la sesión.
 */
@Injectable()
export class SupportSessionResolver {
  private readonly logger = new Logger(SupportSessionResolver.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: SupportSessionCache,
    private readonly fin: SupportEndedNotice,
  ) {}

  async vigente(
    id: string,
    userId: string,
    ahora: Date = new Date(),
  ): Promise<SesionDeSoporteEnCurso> {
    if (!UUID_RE.test(id)) throw soporteInexistente();

    const enCache = await this.cache.leer(id);
    if (enCache && enCache.expiresAt.getTime() > ahora.getTime()) {
      if (enCache.requestedBy !== userId) throw soporteInexistente();
      // La caché no sabe si la empresa se suspendió o se dio de baja después:
      // eso se mira siempre (una consulta por clave primaria).
      if (!(await this.empresaDisponible(enCache.distributorId))) {
        await this.cerrarPorEmpresaNoDisponible(id);
        throw soporteTerminado();
      }
      return {
        id: enCache.id,
        distributorId: enCache.distributorId,
        scope: enCache.scope,
        expiresAt: enCache.expiresAt,
      };
    }

    const filas: FilaDeSesion[] = await this.dataSource.query(
      `SELECT s."support_session_id" AS id, s."requested_by", s."distributor_id",
              s."status", s."scope", s."expires_at",
              s."expires_at" > now() AS vigente,
              d."status" AS distributor_status,
              d."deletedAt" IS NOT NULL AS distributor_baja
         FROM "support_session" s
         JOIN "distributor" d ON d."distributor_id" = s."distributor_id"
        WHERE s."support_session_id" = $1`,
      [id],
    );
    const fila = filas[0];
    if (!fila || fila.requested_by !== userId) throw soporteInexistente();
    if (
      fila.status !== SupportSessionStatus.ACTIVE ||
      !fila.vigente ||
      !fila.expires_at
    ) {
      throw soporteTerminado();
    }
    if (
      fila.distributor_baja ||
      fila.distributor_status !== DistributorStatus.ACTIVE
    ) {
      await this.cerrarPorEmpresaNoDisponible(id);
      throw soporteTerminado();
    }

    const sesion = {
      id: fila.id,
      requestedBy: fila.requested_by,
      distributorId: fila.distributor_id,
      scope: fila.scope,
      expiresAt: new Date(fila.expires_at),
    };
    await this.cache.guardar(sesion, ahora);
    return {
      id: sesion.id,
      distributorId: sesion.distributorId,
      scope: sesion.scope,
      expiresAt: sesion.expiresAt,
    };
  }

  private async empresaDisponible(distributorId: string): Promise<boolean> {
    const filas: Array<{ disponible: boolean }> = await this.dataSource.query(
      `SELECT ("status" = $2 AND "deletedAt" IS NULL) AS disponible
         FROM "distributor" WHERE "distributor_id" = $1`,
      [distributorId, DistributorStatus.ACTIVE],
    );
    return filas[0]?.disponible === true;
  }

  /** La empresa se suspendió o se dio de baja con la sesión abierta (R11). */
  private async cerrarPorEmpresaNoDisponible(id: string): Promise<void> {
    const cerrada = await this.dataSource.transaction(async (manager) => {
      const sesion = await bloquearSesion(manager, id);
      if (sesion?.status !== SupportSessionStatus.ACTIVE) return null;
      return transicionar(
        manager,
        sesion,
        AccionDeSoporte.REVOCAR,
        cierre(SupportEndReason.REVOKED_BY_PLATFORM, null, new Date()),
      );
    });
    await this.cache.olvidar(id);
    if (cerrada) this.fin.avisar(cerrada);
    this.logger.warn(
      `Sesión de soporte ${id} cerrada: la empresa ya no está disponible`,
    );
  }
}
