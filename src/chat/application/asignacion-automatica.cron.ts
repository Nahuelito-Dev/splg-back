import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { ProcessName } from '../../process-run/domain/process-catalog';
import {
  marcarSaltada,
  registrarElementoBien,
  registrarErrorAtrapado,
  registrarFallaDeElemento,
} from '../../process-run/process-run.context';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { RedisService } from '../../redis/redis.service';
import { AgentesDeLaBandeja } from '../infrastructure/agentes-de-la-bandeja';
import { AsignacionAutomaticaService } from './asignacion-automatica.service';
import { EquipoDeLaBandejaService } from './equipo-de-la-bandeja.service';

export interface ResultadoDeLaAsignacionAutomatica {
  /** Las empresas con la función prendida que se miraron. */
  companies: number;
  /** Las conversaciones asignadas en esta corrida. */
  assigned: number;
}

/**
 * Cada minuto (una sola instancia, con cerrojo): la red de seguridad de la
 * asignación automática (8b). Reparte la cola de cada empresa con la función
 * prendida (lo que un disparador no llegó a repartir: un aviso perdido, el
 * horario que abrió, alguien que volvió a estar disponible) y avisa
 * `chat:team` de quien cambió sin que nadie hiciera nada (venció la gracia de
 * una desconexión, cerró el horario). Aparece en el monitoreo como
 * `chat_auto_assign`. Cada empresa por su lado: la que falla queda para la
 * próxima corrida y no frena a las demás.
 */
@Injectable()
export class AsignacionAutomaticaCron {
  static readonly CERROJO = 'cron:chat-auto-assign';
  static readonly CERROJO_TTL_MS = 50_000;

  private readonly logger = new Logger(AsignacionAutomaticaCron.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly agentes: AgentesDeLaBandeja,
    private readonly asignacion: AsignacionAutomaticaService,
    private readonly equipo: EquipoDeLaBandejaService,
  ) {}

  @Cron('20 * * * * *')
  @ConRegistro(ProcessName.CHAT_AUTO_ASSIGN)
  async repartir(): Promise<ResultadoDeLaAsignacionAutomatica | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        AsignacionAutomaticaCron.CERROJO,
        AsignacionAutomaticaCron.CERROJO_TTL_MS,
        () => this.barrer(new Date()),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(
        'Asignación automática del chat: la está procesando otra instancia',
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Asignación automática del chat: la ejecución falló: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }

  async barrer(ahora: Date): Promise<ResultadoDeLaAsignacionAutomatica> {
    const empresas = await this.agentes.empresasConLaFuncion(
      this.dataSource.manager,
    );
    const resultado: ResultadoDeLaAsignacionAutomatica = {
      companies: empresas.length,
      assigned: 0,
    };
    for (const distributorId of empresas) {
      try {
        const hechas = await this.asignacion.repartir(distributorId, ahora);
        resultado.assigned += hechas.length;
        await this.equipo.avisar(distributorId, undefined, ahora);
        registrarElementoBien(`empresa:${distributorId}`);
      } catch (error) {
        registrarFallaDeElemento(`empresa:${distributorId}`, error);
        this.logger.error(
          `Asignación automática del chat: falló la distribuidora ${distributorId}: ${errorMessage(error)}`,
        );
      }
    }
    return resultado;
  }
}
