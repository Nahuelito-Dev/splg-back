import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../common/errors/error-message';
import { ZONA_ARGENTINA } from '../common/utils/dias-argentina';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { RedisService } from '../redis/redis.service';
import { RepurchaseEstimatorService } from './repurchase-estimator.service';
import { RepurchaseForecastService } from './repurchase-forecast.service';
import {
  marcarCorridaDeHoy,
  tocaCorrerHoy,
  ultimaCorridaDeLaEmpresa,
} from '../common/utils/corrida-diaria';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { ProcessName } from '../process-run/domain/process-catalog';
import { EmpresasParaProceso } from '../process-run/empresas-para-proceso';

/**
 * CU-106: el proceso automático de la recompra anticipada.
 *
 * - Cada hora recorre las distribuidoras activas que la tienen encendida
 *   (`enabled`; viene apagada) y corre la anticipación en la que toca
 *   (`runHour`, de 8 a 21; por omisión las 9). Una vez por día.
 * - Cada cinco minutos vence las invitaciones cuya vigencia terminó (sólo en las
 *   que la tienen encendida), cierra las de las distribuidoras que ya no están
 *   activas y avisa a los clientes cuya invitación llegó a la hora de su franja
 *   (la corrida diaria la crea con `notifyAt`; el aviso sale acá).
 *
 * Con varias instancias corre una sola (cerrojo distribuido) y el cerrojo se
 * libera pase lo que pase. La corrida es idempotente: si se repite, no invita
 * dos veces al mismo cliente.
 */
@Injectable()
export class RepurchaseCron {
  static readonly CERROJO_DIARIO = 'cron:repurchase';
  static readonly CERROJO_VENCIMIENTOS = 'cron:repurchase-expiry';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(RepurchaseCron.name);

  constructor(
    private readonly forecast: RepurchaseForecastService,
    private readonly estimator: RepurchaseEstimatorService,
    private readonly distributors: DistributorService,
    private readonly redis: RedisService,
    private readonly empresas: EmpresasParaProceso,
  ) {}

  @Cron('0 0 * * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.REPURCHASE_ANTICIPATE)
  async anticipar(): Promise<number | undefined> {
    return this.conCerrojo(RepurchaseCron.CERROJO_DIARIO, () =>
      this.anticiparLasQueTocan(new Date()),
    );
  }

  @Cron('0 */5 * * * *')
  @ConRegistro(ProcessName.REPURCHASE_EXPIRY)
  async vencer(): Promise<{ closed: number; notified: number } | undefined> {
    return this.conCerrojo(RepurchaseCron.CERROJO_VENCIMIENTOS, async () => {
      const ahora = new Date();
      let cerradas = 0;
      let avisadas = 0;
      for (const d of await this.distributors.findAll()) {
        try {
          if (d.status !== DistributorStatus.ACTIVE) {
            // Una distribuidora que ya no está activa no atiende invitaciones.
            cerradas += await this.forecast.cerrarLasDeUnaDistribuidoraInactiva(
              d.distributorId,
              ahora,
            );
          } else if (
            (await this.estimator.parametros(d.distributorId)).enabled
          ) {
            cerradas += await this.forecast.vencer(ahora, d.distributorId);
            avisadas += await this.forecast.enviarAvisos(
              ahora,
              d.distributorId,
            );
          }
        } catch (error) {
          registrarErrorAtrapado(error);
          this.logger.error(
            `Recompra ${d.distributorId}: el barrido falló: ${errorMessage(error)}`,
          );
        }
      }
      if (cerradas > 0) {
        this.logger.log(`Recompra: ${cerradas} invitación(es) cerrada(s)`);
      }
      if (avisadas > 0) {
        this.logger.log(`Recompra: ${avisadas} aviso(s) en su franja`);
      }
      return { closed: cerradas, notified: avisadas };
    });
  }

  /**
   * Corre la anticipación de las distribuidoras activas con la recompra
   * habilitada por la plataforma (módulo `repurchase`) cuya hora de ejecución
   * es la actual. Con el módulo apagado no se crean invitaciones nuevas; las
   * vigentes vencen solas (`vencer`).
   */
  async anticiparLasQueTocan(ahora: Date): Promise<number> {
    const { empresas } = await this.empresas.recorrer(
      {
        proceso: ProcessName.REPURCHASE_ANTICIPATE,
        modulo: 'repurchase',
        crea: true,
      },
      async (distributorId, empresa) => {
        const params = await this.estimator.parametros(distributorId);
        if (
          !params.enabled ||
          !tocaCorrerHoy(
            ahora,
            params.runHour,
            await ultimaCorridaDeLaEmpresa(
              this.redis,
              ProcessName.REPURCHASE_ANTICIPATE,
              distributorId,
            ),
          )
        )
          return false;
        // Sin caché, justo antes de invitar (§6.3).
        if (!(await empresa.sigueHabilitada())) return false;
        await this.forecast.ejecutar(distributorId, ahora);
        await marcarCorridaDeHoy(
          this.redis,
          ProcessName.REPURCHASE_ANTICIPATE,
          distributorId,
          ahora,
        );
        return true;
      },
    );
    return empresas.filter((e) => e.valor === true).length;
  }

  private async conCerrojo<T>(
    clave: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        clave,
        RepurchaseCron.CERROJO_TTL_MS,
        fn,
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(`Recompra (${clave}): la procesa otra instancia`);
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Recompra (${clave}): la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }
}
