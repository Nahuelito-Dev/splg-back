import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { RedisService } from '../../redis/redis.service';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { errorMessage } from '../../common/errors/error-message';
import { AuditoriaDeDatos } from '../../audit/data/auditoria-de-datos';
import { AuditActionTypeId } from '../../audit/entities/audit-action-type.entity';
import { ConRegistro } from '../../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';

/**
 * Días que se conservan los datos de quien recibió un pedido, contados desde
 * que se entregó (o se canceló). Es el plazo de reclamo del pedido: un reclamo
 * posterior necesita saber quién recibió, y pasado el plazo son datos
 * personales de un tercero sin razón para seguir guardados.
 */
export const PLAZO_DE_RECLAMO_DIAS = 30;

/**
 * CU-128, paso 6: proceso diario que anula el nombre, el documento y la
 * relación de quien recibió en los pedidos cuyo plazo de reclamo venció. Es
 * mantenimiento del sistema: un único barrido sobre todas las distribuidoras,
 * con cerrojo distribuido para que corra una sola instancia.
 */
@Injectable()
export class ReceiverRetentionCron {
  static readonly CERROJO = 'cron:order-receiver-retention';
  static readonly CERROJO_TTL_MS = 5 * 60_000;

  private readonly logger = new Logger(ReceiverRetentionCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 40 3 * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.RECEIVER_RETENTION)
  async anularVencidos() {
    try {
      const bloqueo = await this.redis.withLock(
        ReceiverRetentionCron.CERROJO,
        ReceiverRetentionCron.CERROJO_TTL_MS,
        () => this.barrer(),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(
        'Datos de quien recibe: los está procesando otra instancia',
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Datos de quien recibe: la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Anula los datos de los pedidos vencidos y deja asentada la anulación en la
   * auditoría (sin los datos). Un pedido con un reclamo abierto (pendiente o en
   * proceso) conserva los datos hasta que el reclamo se cierre. Devuelve cuántos
   * pedidos limpió.
   */
  async barrer(): Promise<number> {
    const ids = await this.dataSource.transaction(async (manager) => {
      const [filas]: [
        Array<{ order_id: string; distributor_id: string }>,
        number,
      ] = await manager.query(
        `UPDATE "order" o
              SET "receiver_name" = NULL,
                  "receiver_document" = NULL,
                  "receiver_relationship" = NULL
            WHERE (o."receiver_name" IS NOT NULL
                   OR o."receiver_document" IS NOT NULL
                   OR o."receiver_relationship" IS NOT NULL)
              AND o."status" IN ('delivered', 'cancelled')
              AND COALESCE(o."deliveredAt", o."updatedAt")
                  < now() - make_interval(days => $1)
              AND NOT EXISTS (
                SELECT 1 FROM "claims" c
                 WHERE c."order_id" = o."order_id"
                   AND c."status" IN ('pending', 'in_process'))
          RETURNING o."order_id", o."distributor_id"`,
        [PLAZO_DE_RECLAMO_DIAS],
      );
      for (const f of filas) {
        // Sin los valores: sólo que se anularon por plazo vencido.
        await AuditoriaDeDatos.registrar(manager, {
          actionTypeId: AuditActionTypeId.UPDATE,
          entity: 'Order',
          recordId: f.order_id,
          distributorId: f.distributor_id,
          details: [
            {
              field: 'receiver',
              oldValue: '[datos de quien recibe]',
              newValue: '[anulados por plazo de reclamo vencido]',
            },
          ],
        });
      }
      return filas.map((f) => f.order_id);
    });
    if (ids.length > 0) {
      // Sólo la cantidad: los datos anulados no se vuelcan al log.
      this.logger.log(
        `Datos de quien recibe anulados por plazo de reclamo vencido: ${ids.length} pedido(s)`,
      );
    }
    return ids.length;
  }
}
