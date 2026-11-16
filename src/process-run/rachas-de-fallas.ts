import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import { errorMessage } from '../common/errors/error-message';
import { diaArgentino } from '../common/utils/dias-argentina';
import { RedisService } from '../redis/redis.service';
import { CATALOGO, ProcessName } from './domain/process-catalog';
import { sanitizarError } from './domain/sanitizar-error';
import type { CorridaEnCurso } from './process-run.context';

/** Corridas seguidas fallando con el mismo elemento para avisar a la plataforma. */
export const FALLAS_SEGUIDAS_PARA_AVISAR = 3;
/** Una racha sin novedades (el elemento dejó de aparecer) se olvida a las 24 h. */
const TTL_DE_LA_RACHA_SEG = 24 * 60 * 60;
/** Tope de elementos con racha por proceso (lo demás se descarta del más nuevo). */
const MAXIMO_DE_ELEMENTOS = 500;

/** Lo que dejó la corrida en las rachas. */
export interface ResultadoDeRachas {
  /** Elementos que fallaron en esta corrida y llevan 3 o más corridas seguidas fallando. */
  persistentes: number;
  /** De esos, los que llegaron a 3 en esta corrida (se avisó a la plataforma). */
  avisados: number;
}

const SIN_RACHAS: ResultadoDeRachas = { persistentes: 0, avisados: 0 };

/**
 * Rachas de fallas por elemento de los procesos que recorren varios (tickets,
 * chats, días, lotes, empresas). Cada corrida suma uno a los elementos que
 * fallaron y corta la racha de los que salieron bien; al llegar a 3 corridas
 * seguidas, un único aviso a la bandeja de la plataforma (el mismo tipo que
 * el monitoreo, `process_run_alert`). El elemento se sigue reintentando y
 * cada corrida en que falla sigue quedando `partial`: lo persistente se ve
 * en el contador `persistentFailures` de la corrida, no se esconde.
 *
 * Las rachas viven en Redis (una clave por proceso y empresa), así no se
 * pierden si la corrida siguiente la toma otra instancia; los procesos que
 * recorren elementos corren con cerrojo, una corrida a la vez. Si Redis
 * falla, se loguea y la corrida sigue: es un aviso, no la corrida.
 */
@Injectable()
export class RachasDeFallas implements OnModuleInit {
  /** La instancia viva, para que el registrador llegue sin tocar constructores (como `ProcessRunRecorder`). */
  private static activa: RachasDeFallas | null = null;

  private readonly logger = new Logger(RachasDeFallas.name);

  constructor(
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
  ) {}

  static instalada(): RachasDeFallas | null {
    return RachasDeFallas.activa;
  }

  /** Sólo para pruebas. */
  static desinstalar(): void {
    RachasDeFallas.activa = null;
  }

  onModuleInit(): void {
    RachasDeFallas.activa = this;
  }

  async seguir(
    proceso: ProcessName,
    distributorId: string | null,
    estado: CorridaEnCurso,
    ahora: Date = new Date(),
  ): Promise<ResultadoDeRachas> {
    const { fallidos, bien } = estado.elementos;
    if (fallidos.size === 0 && bien.size === 0) return SIN_RACHAS;
    const clave = `proceso:rachas:${proceso}:${distributorId ?? 'global'}`;
    try {
      const crudo = await this.redis.get(clave);
      if (!crudo && fallidos.size === 0) return SIN_RACHAS;
      const rachas = leer(crudo);
      for (const elemento of bien) delete rachas[elemento];
      const resultado = { persistentes: 0, avisados: 0 };
      for (const [elemento, error] of fallidos) {
        const n = (rachas[elemento] ?? 0) + 1;
        rachas[elemento] = n;
        if (n >= FALLAS_SEGUIDAS_PARA_AVISAR) resultado.persistentes += 1;
        if (n === FALLAS_SEGUIDAS_PARA_AVISAR) {
          resultado.avisados += 1;
          this.avisar(proceso, distributorId, elemento, error, ahora);
        }
      }
      const quedan = Object.entries(rachas).slice(0, MAXIMO_DE_ELEMENTOS);
      if (quedan.length === 0) await this.redis.del(clave);
      else {
        await this.redis.setex(
          clave,
          TTL_DE_LA_RACHA_SEG,
          JSON.stringify(Object.fromEntries(quedan)),
        );
      }
      return resultado;
    } catch (error) {
      this.logger.warn(
        `No se pudieron seguir las fallas repetidas de ${proceso}: ${errorMessage(error)}`,
      );
      return SIN_RACHAS;
    }
  }

  private avisar(
    proceso: ProcessName,
    distributorId: string | null,
    elemento: string,
    error: string,
    ahora: Date,
  ): void {
    const titulo = CATALOGO[proceso].title;
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: null,
      kind: 'process_run_alert',
      title: `Proceso automático: ${titulo}`,
      body: `«${titulo}» falla con ${elemento} hace ${FALLAS_SEGUIDAS_PARA_AVISAR} corridas seguidas; se sigue reintentando y el resto se procesa. Último error: ${sanitizarError(error)}`,
      link: { entity: 'process-run', id: proceso },
      dedupeKey: `process-run:${proceso}:${distributorId ?? 'global'}:elemento:${elemento}:${diaArgentino(ahora)}`,
    });
  }
}

function leer(crudo: string | null): Record<string, number> {
  if (!crudo) return {};
  try {
    const valor: unknown = JSON.parse(crudo);
    if (typeof valor !== 'object' || valor === null) return {};
    return Object.fromEntries(
      Object.entries(valor).filter(
        (e): e is [string, number] => typeof e[1] === 'number',
      ),
    );
  } catch {
    return {};
  }
}
