import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { CoverageZone } from './entities/coverage-zone.entity';
import { RedisService } from '../redis/redis.service';
import { AdminGateway } from '../gateways/admin.gateway';
import { AuditoriaDeDatos } from '../audit/data/auditoria-de-datos';
import { AuditActionTypeId } from '../audit/entities/audit-action-type.entity';

/** Evento a los admins cuando el barrido apaga la última zona activa de su distribuidora. */
export const EVENTO_SIN_ZONAS_ACTIVAS = 'coverage:no-active-zones';
import { errorMessage } from '../common/errors/error-message';

/** Una zona desactivada por vencimiento. */
interface ZonaVencida {
  coverage_zone_id: string;
  distributor_id: string;
  name: string;
  valid_until: Date;
}

/**
 * CU-151: desactiva las zonas de cobertura cuya fecha de fin (`valid_until`,
 * exclusiva) ya pasó, de todas las distribuidoras, para que su recargo deje de
 * aplicarse a los pedidos nuevos. No borra la zona ni toca su polígono ni su
 * recargo: los pedidos cobrados con ese recargo se explican con su snapshot.
 *
 * Es mantenimiento del sistema, un único barrido global. Con varias instancias
 * corre una sola (cerrojo distribuido) y, pase lo que pase, el cerrojo se
 * libera para que la ejecución siguiente pueda tomarlo.
 */
@Injectable()
export class CoverageZoneExpiryCron {
  static readonly CERROJO = 'cron:coverage-zone-expiry';
  static readonly CERROJO_TTL_MS = 4 * 60_000;

  private readonly logger = new Logger(CoverageZoneExpiryCron.name);

  constructor(
    @InjectRepository(CoverageZone)
    private readonly zones: Repository<CoverageZone>,
    private readonly redis: RedisService,
    private readonly adminGateway: AdminGateway,
  ) {}

  @Cron('0 */5 * * * *') // cada cinco minutos
  async desactivarVencidas(): Promise<void> {
    try {
      const bloqueo = await this.redis.withLock(
        CoverageZoneExpiryCron.CERROJO,
        CoverageZoneExpiryCron.CERROJO_TTL_MS,
        () => this.barrer(),
      );
      if (!bloqueo.obtenido) {
        this.logger.log('Zonas vencidas: las está procesando otra instancia');
      }
    } catch (error) {
      this.logger.error(
        `Zonas vencidas: la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Marca inactivas las vencidas, deja asentada la auditoría de cada una y
   * avisa a los admins de las distribuidoras que se quedaron sin zonas
   * activas. Devuelve cuántas desactivó.
   */
  async barrer(): Promise<number> {
    // El UPDATE ... RETURNING toma las filas y las marca en un solo paso: dos
    // barridos simultáneos no pueden desactivar dos veces la misma zona. La
    // auditoría va en la misma transacción (el UPDATE crudo no pasa por el
    // subscriber).
    const { zonas, sinZonas } = await this.zones.manager.transaction(
      async (manager) => {
        const [filas]: [ZonaVencida[], number] = await manager.query(
          `UPDATE "coverage_zone"
              SET "isActive" = false, "updatedAt" = now()
            WHERE "isActive" = true
              AND "deletedAt" IS NULL
              AND "valid_until" IS NOT NULL
              AND "valid_until" <= now()
          RETURNING "coverage_zone_id", "distributor_id", "name", "valid_until"`,
        );
        for (const z of filas) {
          await AuditoriaDeDatos.registrar(manager, {
            actionTypeId: AuditActionTypeId.UPDATE,
            entity: 'CoverageZone',
            recordId: z.coverage_zone_id,
            distributorId: z.distributor_id,
            details: [
              { field: 'isActive', oldValue: 'true', newValue: 'false' },
            ],
          });
        }
        const distribuidoras = [...new Set(filas.map((z) => z.distributor_id))];
        const sinZonas: string[] = [];
        for (const id of distribuidoras) {
          const quedan: unknown[] = await manager.query(
            `SELECT 1 FROM "coverage_zone"
              WHERE "distributor_id" = $1 AND "isActive" = true AND "deletedAt" IS NULL
              LIMIT 1`,
            [id],
          );
          if (quedan.length === 0) sinZonas.push(id);
        }
        return { zonas: filas, sinZonas };
      },
    );
    for (const z of zonas) {
      this.logger.log(
        `Zona vencida desactivada: ${z.coverage_zone_id} "${z.name}" (distribuidora ${z.distributor_id}, venció ${new Date(z.valid_until).toISOString()})`,
      );
    }
    for (const distributorId of sinZonas) {
      this.logger.warn(
        `La distribuidora ${distributorId} se quedó sin zonas de cobertura activas`,
      );
      try {
        this.adminGateway.notifyAdmins(
          EVENTO_SIN_ZONAS_ACTIVAS,
          {
            distributorId,
            zoneIds: zonas
              .filter((z) => z.distributor_id === distributorId)
              .map((z) => z.coverage_zone_id),
            at: new Date().toISOString(),
          },
          distributorId,
        );
      } catch (error) {
        this.logger.error(
          `No se pudo avisar a los admins de ${distributorId}: ${errorMessage(error)}`,
        );
      }
    }
    return zonas.length;
  }
}
