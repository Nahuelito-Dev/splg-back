import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { auditContext } from '../../audit/data/audit-context';
import { ProposalStatus } from '../../common/enums/proposal-status.enum';
import { errorCode, errorMessage } from '../../common/errors/error-message';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { Cylinder } from '../entities/cylinder.entity';
import {
  CylinderRecoveryCase,
  RecoveryCaseStatus,
} from '../entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../entities/cylinder-recovery-notice.entity';
import {
  AvisoParaElCliente,
  CylinderRecoveryNotifier,
} from './cylinder-recovery.notifier';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import {
  ParametrosDeRecupero,
  vencimientoDeLaOferta,
} from './domain/recovery-rules';

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Un caso abierto cuyo cliente vive cerca de una parada pendiente de una hoja en curso. */
export interface CandidatoDeRetiro {
  caseId: string;
  /** Pedido de la parada vecina: la oferta queda ligada a él. */
  orderId: string;
  batchId: string;
  sheetNumber: number | null;
  meters: number;
}

/**
 * Retiro aprovechando la hoja (M5b, fase 1): cuando una hoja de ruta del día está
 * en curso, a los clientes con un envase sin devolver que tienen una dirección a
 * menos de `opportunisticPickupRadiusMeters` (en metros, línea recta) de una
 * parada pendiente de esa hoja se les ofrece que el chofer retire el envase en
 * ese viaje. Es el mismo mecanismo de la oferta común: el cliente acepta o
 * rechaza, el chofer lo ve en sus retiros y lo confirma. No cobra nada.
 *
 * Nunca hay dos ofertas vivas para un caso: se revisa bajo el cerrojo del caso y
 * la base lo garantiza con el índice único de la oferta viva.
 */
@Injectable()
export class CylinderRecoveryPickupOpportunityService {
  private readonly logger = new Logger(
    CylinderRecoveryPickupOpportunityService.name,
  );

  constructor(
    @InjectRepository(CylinderRecoveryCase)
    private readonly cases: Repository<CylinderRecoveryCase>,
    private readonly engine: CylinderRecoveryService,
    private readonly notifier: CylinderRecoveryNotifier,
    private readonly acceso: AccesoDeLaEmpresa,
  ) {}

  /**
   * Ofrece los retiros que corresponden. Con `distributorId` sólo esa
   * distribuidora (y, si viene, sólo esa hoja); sin él, todas las que tienen
   * casos abiertos. Devuelve cuántas ofertas creó. Una distribuidora que falla
   * no frena a las demás.
   */
  async ofrecer(
    distributorId: string | null,
    batchId: string | null,
    ahora: Date = new Date(),
  ): Promise<number> {
    const distribuidoras = distributorId
      ? [distributorId]
      : await this.conCasosAbiertos();
    let ofertas = 0;
    for (const d of distribuidoras) {
      try {
        ofertas += await this.ofrecerEnLaDistribuidora(d, batchId, ahora);
      } catch (error) {
        this.logger.warn(
          `Retiro aprovechando la hoja ${d}: ${errorMessage(error)}`,
        );
      }
    }
    return ofertas;
  }

  private async conCasosAbiertos(): Promise<string[]> {
    const filas: Array<{ id: string }> = await this.cases.manager.query(
      `SELECT DISTINCT distributor_id AS id FROM cylinder_recovery_case WHERE status = 'open'`,
    );
    return filas.map((f) => f.id);
  }

  private async ofrecerEnLaDistribuidora(
    distributorId: string,
    batchId: string | null,
    ahora: Date,
  ): Promise<number> {
    if (!(await this.acceso.habilitado(distributorId, 'cylinder_recovery'))) {
      return 0;
    }
    const p = await this.engine.parametros(distributorId);
    if (!p.enabled) return 0;
    const candidatos = await this.candidatos(
      distributorId,
      batchId,
      p.opportunisticPickupRadiusMeters,
      ahora,
    );
    if (candidatos.length === 0) return 0;
    // Los triggers de auditoría asientan con la distribuidora lo que escribe un proceso sin request.
    return auditContext.run({ userId: null, ip: null, distributorId }, () =>
      this.crearOfertas(distributorId, candidatos, p, ahora),
    );
  }

  /**
   * Los casos abiertos sin oferta viva cuyo cliente tiene una dirección a menos
   * de `radioEnMetros` de una parada pendiente (pedido aceptado o en camino, sin
   * «Llegué») de una hoja en curso de hoy, de otro cliente. De cada caso, la
   * parada más cercana que no se le ofreció ya. La distancia se mide sobre
   * `geography`: en metros, no en grados.
   */
  async candidatos(
    distributorId: string,
    batchId: string | null,
    radioEnMetros: number,
    ahora: Date,
  ): Promise<CandidatoDeRetiro[]> {
    const filas: Array<{
      caseId: string;
      orderId: string;
      batchId: string;
      sheetNumber: number | null;
      meters: string;
    }> = await this.cases.manager.query(
      `SELECT DISTINCT ON (k.case_id)
              k.case_id AS "caseId", s.order_id AS "orderId", b.batch_id AS "batchId",
              b."number" AS "sheetNumber",
              ST_Distance(a."location"::geography, o."deliveryPoint"::geography) AS "meters"
         FROM cylinder_recovery_case k
         JOIN route_batch b ON b.distributor_id = k.distributor_id
                           AND b.kind = 'planned' AND b.status = 'assigned'
                           AND b.plan_date = $2::date
                           AND ($3::uuid IS NULL OR b.batch_id = $3::uuid)
         JOIN route_batch_stop s ON s.batch_id = b.batch_id AND s.active AND s.arrived_at IS NULL
         JOIN "order" o ON o.order_id = s.order_id AND o.distributor_id = k.distributor_id
                       AND o.status::text IN ('accepted', 'on_the_way')
                       AND o.customer_id <> k.user_id
                       AND o."deliveryPoint" IS NOT NULL
         JOIN user_address a ON a.user_id = k.user_id AND a."deletedAt" IS NULL
                            AND a."location" IS NOT NULL
        WHERE k.distributor_id = $1 AND k.status = 'open'
          AND ST_DWithin(a."location"::geography, o."deliveryPoint"::geography, $4::float8)
          AND NOT EXISTS (
            SELECT 1 FROM cylinder_recovery_notice n
             WHERE n.case_id = k.case_id AND n.kind = 'pickup_offer'
               AND (n.status IN ('pending', 'accepted') OR n.order_id = s.order_id))
        ORDER BY k.case_id, ST_Distance(a."location"::geography, o."deliveryPoint"::geography), s.order_id`,
      [distributorId, diaArgentino(ahora), batchId, radioEnMetros],
    );
    return filas.map((f) => ({ ...f, meters: Number(f.meters) }));
  }

  private async crearOfertas(
    distributorId: string,
    candidatos: CandidatoDeRetiro[],
    p: ParametrosDeRecupero,
    ahora: Date,
  ): Promise<number> {
    const porCliente = new Map<string, AvisoParaElCliente[]>();
    let ofertas = 0;
    for (const c of candidatos) {
      try {
        const creada = await this.crearOferta(distributorId, c, p, ahora);
        if (!creada) continue;
        ofertas += 1;
        this.notifier.porSocket(creada.caso, creada.aviso, creada.ctx);
        const lista = porCliente.get(creada.caso.userId) ?? [];
        lista.push(creada);
        porCliente.set(creada.caso.userId, lista);
      } catch (error) {
        this.logger.error(
          `Retiro aprovechando la hoja ${distributorId}: falló el caso ${c.caseId}: ${errorMessage(error)}`,
        );
      }
    }
    for (const [userId, avisos] of porCliente) {
      await this.notifier.alClienteAgrupado(userId, avisos);
    }
    return ofertas;
  }

  /** Crea la oferta bajo el cerrojo del caso; null si ya no corresponde. */
  private async crearOferta(
    distributorId: string,
    c: CandidatoDeRetiro,
    p: ParametrosDeRecupero,
    ahora: Date,
  ): Promise<AvisoParaElCliente | null> {
    try {
      return await this.cases.manager.transaction(async (manager) => {
        const caso = await manager
          .createQueryBuilder(CylinderRecoveryCase, 'c')
          .setLock('pessimistic_write')
          .where('c.caseId = :caseId', { caseId: c.caseId })
          .andWhere('c.distributorId = :distributorId', { distributorId })
          .getOne();
        if (!caso || caso.status !== RecoveryCaseStatus.OPEN) return null;
        const previos = await manager.find(CylinderRecoveryNotice, {
          where: { caseId: caso.caseId, kind: RecoveryNoticeKind.PICKUP_OFFER },
        });
        const hayViva = previos.some(
          (a) =>
            a.status === ProposalStatus.PENDING ||
            a.status === ProposalStatus.ACCEPTED,
        );
        if (hayViva || previos.some((a) => a.orderId === c.orderId)) {
          return null;
        }
        const envase = await manager
          .getRepository(Cylinder)
          .findOne({ where: { cylinderId: caso.cylinderId, distributorId } });
        const aviso = await manager.save(
          manager.create(CylinderRecoveryNotice, {
            caseId: caso.caseId,
            step: caso.step,
            kind: RecoveryNoticeKind.PICKUP_OFFER,
            status: ProposalStatus.PENDING,
            orderId: c.orderId,
            routeBatchId: c.batchId,
            expiresAt: vencimientoDeLaOferta(ahora, p),
          }),
        );
        return {
          caso,
          aviso,
          ctx: {
            serial: envase?.serial ?? '',
            diasAfuera: Math.max(
              0,
              Math.floor(
                (ahora.getTime() - caso.deliveredAt.getTime()) / MS_POR_DIA,
              ),
            ),
            retiroAprovechandoLaHoja: true,
          },
        };
      });
    } catch (error) {
      // Otra pasada ofreció primero: el índice único deja una sola oferta viva por caso.
      if (errorCode(error) === '23505') return null;
      throw error;
    }
  }
}
