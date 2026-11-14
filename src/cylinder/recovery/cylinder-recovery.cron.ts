import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../redis/redis.service';
import { errorMessage } from '../../common/errors/error-message';
import {
  minutosDelDiaArgentino,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import { CylinderRecoveryService } from './cylinder-recovery.service';
import { ConRegistro } from '../../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';
import { EmpresasParaProceso } from '../../process-run/empresas-para-proceso';

/**
 * CU-108: el proceso automático de la recuperación de envases. Cada hora
 * recorre las distribuidoras con envases afuera y corre la gestión en la que
 * toca (`runHour`, por distribuidora; por omisión las 10) y sólo si la tiene encendida (`enabled`, apagado por omisión). Se saltean las suspendidas. Una vez por día.
 *
 * Con varias instancias corre una sola (cerrojo distribuido) y el cerrojo se
 * libera pase lo que pase. La corrida es idempotente, así que repetirla no
 * duplica casos ni avisos.
 */
@Injectable()
export class CylinderRecoveryCron {
  static readonly CERROJO = 'cron:cylinder-recovery';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(CylinderRecoveryCron.name);

  constructor(
    private readonly recovery: CylinderRecoveryService,
    private readonly redis: RedisService,
    private readonly empresas: EmpresasParaProceso,
  ) {}

  @Cron('0 0 * * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.CYLINDER_RECOVERY)
  async recuperar() {
    try {
      const bloqueo = await this.redis.withLock(
        CylinderRecoveryCron.CERROJO,
        CylinderRecoveryCron.CERROJO_TTL_MS,
        () => this.recuperarLasQueTocan(new Date()),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log('Recupero de envases: lo está procesando otra instancia');
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Recupero de envases: la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Corre la gestión de las distribuidoras cuya hora de ejecución es la
   * actual y que tienen el recupero habilitado por la plataforma (módulo
   * `cylinder_recovery`). Con el módulo apagado no se abren casos ni se
   * escalan; las ofertas de retiro vigentes siguen.
   */
  async recuperarLasQueTocan(ahora: Date): Promise<number> {
    const hora = Math.floor(minutosDelDiaArgentino(ahora) / 60);
    const { empresas } = await this.empresas.recorrer(
      {
        proceso: ProcessName.CYLINDER_RECOVERY,
        modulo: 'cylinder_recovery',
        crea: true,
        entre: await this.recovery.distribuidorasConEnvasesAfuera(),
      },
      async (distributorId, empresa) => {
        const params = await this.recovery.parametros(distributorId);
        if (!params.enabled || params.runHour !== hora) return false;
        // Sin caché, justo antes de abrir casos y ofertas (§6.3).
        if (!(await empresa.sigueHabilitada())) return false;
        const r = await this.recovery.ejecutar(distributorId, ahora);
        this.logger.log(
          `Recupero ${distributorId}: ${r.abiertos} caso(s) nuevo(s), ${r.avisos} aviso(s), ${r.ofertas} oferta(s), ${r.escalados} escalado(s), ${r.perdidos} perdido(s), ${r.cerradosPorDevolucion} devuelto(s), ${r.cerradosPorCuenta} cubierto(s) por la cuenta, ${r.revisionManual} para revisión manual`,
        );
        return true;
      },
    );
    return empresas.filter((e) => e.valor === true).length;
  }
}
