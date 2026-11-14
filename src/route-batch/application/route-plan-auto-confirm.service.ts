import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { errorCode, errorMessage } from '../../common/errors/error-message';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import type { ValoresDeProceso } from '../../distributor/process-config';
import { registrarErrorAtrapado } from '../../process-run/process-run.context';
import { revisionVencida } from '../domain/confirmacion-automatica';
import { diaSiguiente } from '../domain/route-sheet-rules';
import type { RouteSheetViolation } from '../domain/route-sheet-rules';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { RouteSheetLifecycleService } from './route-sheet-lifecycle.service';
import { RouteSheetNotifier, diaLegible } from './route-sheet-notifier.service';
import { ROUTE_PLAN_CODES } from './route-sheet.exceptions';

export interface ResumenDeConfirmacion {
  /** Hojas que se confirmaron solas. */
  autoConfirmed: number;
  /** Hojas que quedaron en borrador por una violación (se avisó al admin). */
  autoConfirmFailed: number;
  /** Hojas que el admin tenía tomadas (versión o cerrojo): se reintentan en la pasada siguiente. */
  autoConfirmRetry: number;
}

/** 40P01 deadlock_detected y 40001 serialization_failure: se reintenta, no es una falla. */
const CHOQUE_CON_OTRA_TRANSACCION = new Set(['40P01', '40001']);

/** El SQLSTATE del error de la base (`QueryFailedError` lo copia del driver). */
const codigoDeLaBase = (error: unknown): string | undefined =>
  errorCode(error) ??
  errorCode((error as { driverError?: unknown } | null)?.driverError);

interface BorradorCandidato {
  batchId: string;
  distributorId: string;
  planDate: string;
  version: number;
  number: number | null;
  driverName: string | null;
  proposedAt: Date;
  editedAt: Date | null;
}

/**
 * Confirmación automática (F34, «lo más automático posible»): pasados
 * `reviewMinutes` desde la propuesta del día, confirma solos los borradores
 * que se pueden confirmar, con la misma operación que `POST …/confirm`
 * (`RouteSheetLifecycleService.confirmar`: misma validación, mismos avisos al
 * cliente y al chofer) y actor de sistema. Lo que no se puede confirmar queda
 * en borrador y se avisa en la bandeja con el motivo. Si el admin la tiene
 * tomada (otra versión o el cerrojo de la hoja), no se pisa: se reintenta en
 * la pasada siguiente. La corre el proceso `route_planning_propose`.
 */
@Injectable()
export class RoutePlanAutoConfirmService {
  private readonly logger = new Logger(RoutePlanAutoConfirmService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly processConfig: ProcessConfigService,
    private readonly lifecycle: RouteSheetLifecycleService,
    private readonly notifier: RouteSheetNotifier,
    private readonly acceso: AccesoDeLaEmpresa,
  ) {}

  async confirmarLasVencidas(ahora: Date): Promise<ResumenDeConfirmacion> {
    const r: ResumenDeConfirmacion = {
      autoConfirmed: 0,
      autoConfirmFailed: 0,
      autoConfirmRetry: 0,
    };
    const hoy = diaArgentino(ahora);
    // `null`: no se pudieron leer sus parámetros en esta pasada (se saltean
    // sus hojas; las de las demás distribuidoras siguen).
    const parametros = new Map<string, ValoresDeProceso | null>();
    for (const b of await this.candidatos(hoy)) {
      if (!parametros.has(b.distributorId)) {
        parametros.set(
          b.distributorId,
          await this.parametrosDe(b.distributorId),
        );
      }
      const v = parametros.get(b.distributorId);
      if (!v || v.enabled !== 1 || v.autoConfirm !== 1) continue;
      const vencida = revisionVencida(
        {
          proposedAtMs: b.proposedAt.getTime(),
          editedAtMs: b.editedAt?.getTime() ?? null,
          reabierta: b.number !== null,
        },
        v.reviewMinutes,
        ahora.getTime(),
      );
      if (!vencida) continue;
      const resultado = await this.confirmar(b, hoy);
      if (resultado === 'confirmada') r.autoConfirmed += 1;
      else if (resultado === 'no_confirmable') r.autoConfirmFailed += 1;
      else if (resultado === 'reintentar') r.autoConfirmRetry += 1;
    }
    return r;
  }

  /**
   * Los parámetros de la distribuidora, o `null` si fallaron: la falla queda en
   * la corrida (`process_run` parcial) con el id de la distribuidora y no frena
   * a las demás.
   */
  private async parametrosDe(
    distributorId: string,
  ): Promise<ValoresDeProceso | null> {
    try {
      // Con la hoja de ruta deshabilitada por la plataforma (o la empresa
      // bloqueada) los borradores no se confirman solos. Sin caché (§6.3).
      const acceso = await this.acceso.calcular(distributorId);
      if (!acceso.modulos.has('route_planning')) return null;
      return await this.processConfig.obtener(
        distributorId,
        ConfigurableProcess.ROUTE_PLANNING,
      );
    } catch (error) {
      registrarErrorAtrapado(error);
      this.logger.error(
        `Confirmación automática de la distribuidora ${distributorId}: no se pudieron leer los parámetros: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async confirmar(
    b: BorradorCandidato,
    hoy: string,
  ): Promise<'confirmada' | 'no_confirmable' | 'reintentar' | 'omitida'> {
    try {
      await this.lifecycle.confirmar(
        b.distributorId,
        b.batchId,
        { version: b.version },
        null,
      );
      this.logger.log(
        `Hoja ${b.batchId} (${b.planDate}) confirmada sola al vencer la revisión`,
      );
      return 'confirmada';
    } catch (error) {
      const codigo = codigoDeLaBase(error);
      if (codigo && CHOQUE_CON_OTRA_TRANSACCION.has(codigo)) {
        // Deadlock o falla de serialización con otra operación sobre la hoja o
        // sus pedidos (p. ej. la cancelación de uno): no es una falla del
        // proceso; la transacción se deshizo y va en la pasada siguiente.
        this.logger.warn(
          `Hoja ${b.batchId}: la confirmación automática chocó con otra operación (${codigo}); se reintenta en la pasada siguiente`,
        );
        return 'reintentar';
      }
      if (!(error instanceof HttpException)) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Hoja ${b.batchId}: falló la confirmación automática: ${errorMessage(error)}`,
        );
        return 'omitida';
      }
      const cuerpo = error.getResponse() as {
        code?: string;
        violations?: RouteSheetViolation[];
      };
      if (
        cuerpo.code === ROUTE_PLAN_CODES.SHEET_VERSION_CONFLICT ||
        cuerpo.code === ROUTE_PLAN_CODES.SHEET_BUSY
      ) {
        // El admin la está editando: no se pisa, va en la pasada siguiente.
        return 'reintentar';
      }
      if (cuerpo.code === ROUTE_PLAN_CODES.SHEET_NOT_CONFIRMABLE) {
        this.avisarNoConfirmada(b, hoy, cuerpo.violations ?? []);
        return 'no_confirmable';
      }
      // Ya no es un borrador, se cerró el día o se la dio de baja: nada que hacer.
      this.logger.log(
        `Hoja ${b.batchId}: no se confirmó sola (${errorMessage(error)})`,
      );
      return 'omitida';
    }
  }

  /**
   * Después de la propuesta automática: si quedaron pedidos sin hoja porque no
   * hay choferes y vehículos disponibles ese día, se avisa en la bandeja. Esos
   * pedidos no quedan retenidos para siempre: la retención de la
   * planificación termina cuando empieza el día del reparto (y el cierre del
   * día lo cierra), y ahí pasan al despacho común como cualquier pedido.
   */
  avisarSinHojaPosible(
    distributorId: string,
    planDate: string,
    unassigned: ReadonlyArray<{ orderId: string; reason: string }>,
    ahora: Date,
  ): boolean {
    const sinFlota = unassigned.filter((u) => u.reason === 'no_vehicles');
    if (sinFlota.length === 0) return false;
    const hoy = diaArgentino(ahora);
    const dia =
      planDate === diaSiguiente(hoy)
        ? `mañana (${diaLegible(planDate)})`
        : `el ${diaLegible(planDate)}`;
    const cuantos =
      sinFlota.length === 1
        ? '1 pedido quedó'
        : `${sinFlota.length} pedidos quedaron`;
    this.notifier.aLaBandeja(distributorId, {
      kind: 'route_plan_no_vehicles',
      title: 'Pedidos sin hoja de ruta',
      body: `Para ${dia}, ${cuantos} sin hoja de ruta porque no hay choferes y vehículos disponibles ese día. Si no armás una hoja, pasan al despacho común cuando empiece el día.`,
      dedupeKey: `route-plan-no-vehicles:${distributorId}:${planDate}`,
    });
    return true;
  }

  private avisarNoConfirmada(
    b: BorradorCandidato,
    hoy: string,
    violaciones: readonly RouteSheetViolation[],
  ): void {
    const cual =
      b.number !== null
        ? `La hoja N° ${b.number}`
        : `La hoja de ${b.driverName ?? 'un chofer sin asignar'}`;
    const dia =
      b.planDate === hoy
        ? 'de hoy'
        : b.planDate === diaSiguiente(hoy)
          ? 'de mañana'
          : `del ${diaLegible(b.planDate)}`;
    const motivo =
      violaciones.length > 0
        ? violaciones.map((v) => v.message).join('; ')
        : 'no cumple las condiciones para confirmarse';
    this.notifier.aLaBandeja(b.distributorId, {
      kind: 'route_sheet_auto_confirm_failed',
      title: 'Hoja de ruta sin confirmar',
      body: `${cual} ${dia} no se confirmó sola: ${motivo}. Corregila y confirmala desde la hoja de ruta.`,
      // Un aviso por versión de la hoja: si el admin la cambia y sigue sin
      // poder confirmarse, se avisa de nuevo; si no la toca, no se repite.
      dedupeKey: `route-sheet-auto-confirm-failed:${b.batchId}:${b.version}`,
    });
  }

  /**
   * Los borradores de días ya propuestos (de hoy en adelante) de las
   * distribuidoras activas. La ventana y los parámetros se miran después, por
   * distribuidora.
   */
  private async candidatos(hoy: string): Promise<BorradorCandidato[]> {
    const filas: Array<{
      batchId: string;
      distributorId: string;
      planDate: string;
      version: number | string;
      number: number | string | null;
      driverName: string | null;
      proposedAt: Date | string;
      editedAt: Date | string | null;
    }> = await this.dataSource.query(
      `SELECT b."batch_id" AS "batchId", b."distributor_id" AS "distributorId",
              to_char(b."plan_date", 'YYYY-MM-DD') AS "planDate", b."version", b."number",
              u."full_name" AS "driverName", p."proposed_at" AS "proposedAt", b."edited_at" AS "editedAt"
         FROM "route_batch" b
         JOIN "route_plan" p ON p."distributor_id" = b."distributor_id" AND p."plan_date" = b."plan_date"
         JOIN "distributor" d ON d."distributor_id" = b."distributor_id"
         LEFT JOIN "delivery" dl ON dl."delivery_id" = b."delivery_id"
         LEFT JOIN "user" u ON u."user_id" = dl."user_id"
        WHERE b."kind" = 'planned' AND b."status" = 'draft'
          AND p."status" = 'proposed' AND p."proposed_at" IS NOT NULL
          AND b."plan_date" >= $1::date
          AND d."deletedAt" IS NULL AND d."status"::text = 'active'
        ORDER BY b."distributor_id", b."plan_date", b."created_at", b."batch_id"`,
      [hoy],
    );
    return filas.map((f) => ({
      batchId: f.batchId,
      distributorId: f.distributorId,
      planDate: f.planDate,
      version: Number(f.version),
      number: f.number === null ? null : Number(f.number),
      driverName: f.driverName,
      proposedAt: new Date(f.proposedAt),
      editedAt: f.editedAt === null ? null : new Date(f.editedAt),
    }));
  }
}
