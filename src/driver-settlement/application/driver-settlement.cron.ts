import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminService } from '../../admin/admin.service';
import { errorMessage } from '../../common/errors/error-message';
import {
  diaArgentino,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import { EmailSenderPort } from '../../email/ports/email-sender.port';
import { armarCorreo } from '../../email/layout/correo';
import {
  marcaDeDistribuidora,
  nombreDeDistribuidoraDeAdmins,
} from '../../email/layout/marca-de-correo';
import { mensajeDeRendicionesSinCerrar } from './correo-rendiciones-sin-cerrar';
import { RedisService } from '../../redis/redis.service';
import { ESTADOS_SIN_CERRAR } from '../domain/driver-settlement.enums';
import { DriverSettlementService } from './driver-settlement.service';
import { ConRegistro } from '../../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';

interface FilaSinCerrar {
  settlement_id: string;
  distributor_id: string;
  number: number;
  business_date: string;
  status: string;
  driver_name: string | null;
}

/**
 * Procesos nocturnos de las rendiciones. Con varias instancias corre sólo una
 * (bloqueo en Redis): si no, las rendiciones se abrirían o el mail saldría dos
 * veces. Si falla, el error se registra y el bloqueo se libera.
 */
@Injectable()
export class DriverSettlementCron {
  private readonly logger = new Logger(DriverSettlementCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rendiciones: DriverSettlementService,
    private readonly admins: AdminService,
    private readonly emailSender: EmailSenderPort,
    private readonly redis: RedisService,
  ) {}

  /** CU-231: a las 23:30 abre la rendición de cada chofer con efectivo sin rendir. */
  @Cron('30 23 * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.DRIVER_SETTLEMENT_GENERATE)
  async generarRendicionesDelDia() {
    const lock = await this.redis.withLock(
      'cron:driver-settlement-generate',
      5 * 60_000,
      async () => {
        const abiertas = await this.rendiciones.generarDelDia();
        this.logger.log(`Rendiciones del día abiertas: ${abiertas}`);
        return abiertas;
      },
    );
    if (lock.obtenido) return lock.valor;
    marcarSaltada();
    this.logger.log('Rendiciones del día: las está abriendo otra instancia');
  }

  /** CU-234: a las 08:00 avisa las rendiciones de días anteriores sin cerrar. */
  @Cron('0 8 * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.DRIVER_SETTLEMENT_ALERT)
  async avisarRendicionesSinCerrar(): Promise<void> {
    const lock = await this.redis.withLock(
      'cron:driver-settlement-overdue',
      5 * 60_000,
      () => this.avisar(),
    );
    if (lock.obtenido) return lock.valor;
    marcarSaltada();
    this.logger.log(
      'Aviso de rendiciones sin cerrar: lo está corriendo otra instancia',
    );
  }

  /** Un correo por distribuidora con las rendiciones abiertas o presentadas de días anteriores. */
  async avisar(): Promise<void> {
    const filas: FilaSinCerrar[] = await this.dataSource.query(
      `SELECT s."settlement_id", s."distributor_id", s."number", s."business_date"::text AS business_date,
              s."status", u."full_name" AS driver_name
       FROM "driver_settlement" s
       JOIN "delivery" d ON d."delivery_id" = s."delivery_id"
       JOIN "user" u ON u."user_id" = d."user_id"
       WHERE s."status"::text = ANY($2::text[]) AND s."business_date" < $1::date
         AND s."overdue_alerted_at" IS NULL
       ORDER BY s."business_date", s."number"`,
      [diaArgentino(), [...ESTADOS_SIN_CERRAR]],
    );
    const porDistribuidora = new Map<string, FilaSinCerrar[]>();
    for (const f of filas) {
      porDistribuidora.set(f.distributor_id, [
        ...(porDistribuidora.get(f.distributor_id) ?? []),
        f,
      ]);
    }
    for (const [distributorId, lista] of porDistribuidora) {
      try {
        await this.avisarDistribuidora(distributorId, lista);
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `No se pudo avisar las rendiciones sin cerrar de ${distributorId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async avisarDistribuidora(
    distributorId: string,
    lista: FilaSinCerrar[],
  ): Promise<void> {
    const admins = await this.admins.findAll(distributorId);
    const destinatarios = admins
      .map((a) => a.user?.email)
      .filter((email): email is string => Boolean(email));
    const correo = armarCorreo(
      marcaDeDistribuidora(nombreDeDistribuidoraDeAdmins(admins)),
      mensajeDeRendicionesSinCerrar(
        lista.map((f) => ({
          numero: f.number,
          dia: f.business_date,
          chofer: f.driver_name,
          presentada: f.status !== 'open',
        })),
      ),
    );
    for (const to of destinatarios) {
      await this.emailSender.send({
        to,
        subject: correo.asunto,
        html: correo.html,
        text: correo.text,
      });
    }
    // Sin administradores con correo no hay a quién avisarle dos veces: se marca igual.
    await this.dataSource.query(
      `UPDATE "driver_settlement" SET "overdue_alerted_at" = now()
       WHERE "settlement_id" = ANY($1::uuid[])`,
      [lista.map((f) => f.settlement_id)],
    );
  }
}
