import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../../common/errors/error-message';
import { RedisService } from '../../redis/redis.service';
import { Channel, ConversationStatus } from '../domain/chat.enums';
import { minutosHabiles } from '../domain/horario-de-la-empresa';
import { medirEspera } from '../domain/metricas';
import {
  APAGADO,
  DIAS_DEL_TIEMPO_ESPERADO,
  type HistoriaDeRespuestas,
  historiaDeRespuestas,
  type TiempoEsperado,
  tiempoEsperado,
} from '../domain/tiempo-de-respuesta';
import { MetricasReadModel } from '../infrastructure/metricas-read-model';
import {
  CompanyChatSettingsService,
  horarioDe,
} from './company-chat-settings.service';

export type CanalDelTiempoEsperado =
  | Channel.STAFF_CUSTOMER
  | Channel.STAFF_DRIVER;

/** Cuánto vive la historia en caché (la mediana de 14 días no cambia de un minuto a otro). */
export const TTL_DEL_TIEMPO_ESPERADO_SEG = 10 * 60;

const DIA_MS = 24 * 60 * 60 * 1000;

export const claveDelTiempoEsperado = (
  distributorId: string,
  canal: CanalDelTiempoEsperado,
) => `chat:expected-reply:v2:${distributorId}:${canal}`;

/**
 * El tiempo de respuesta esperado de una empresa en un canal (tanda 7c). La
 * historia (mediana de la primera respuesta en minutos hábiles de los
 * últimos 14 días) va en Redis por 10 minutos; el interruptor, el objetivo y
 * si atiende ahora se leen siempre (son baratos y tienen que verse al toque).
 * Si Redis falla, se calcula igual.
 */
@Injectable()
export class TiempoEsperadoService {
  private readonly logger = new Logger(TiempoEsperadoService.name);

  constructor(
    private readonly lectura: MetricasReadModel,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Para el cliente (C3) o el chofer (C2). Con el chat de clientes apagado,
   * al cliente no se le promete nada.
   */
  async delCanal(
    distributorId: string,
    canal: CanalDelTiempoEsperado,
    ahora: Date = new Date(),
  ): Promise<TiempoEsperado> {
    const a = await this.ajustes.leer(distributorId);
    const habilitado =
      a.expectedReplyEnabled &&
      (canal !== Channel.STAFF_CUSTOMER || a.customerChatEnabled);
    if (!habilitado) return { ...APAGADO };
    return tiempoEsperado({
      habilitado,
      historia: await this.historia(distributorId, canal, ahora),
      objetivoMinutos: a.firstResponseTargetMinutes,
      horario: horarioDe(a),
      ahora,
    });
  }

  private async historia(
    distributorId: string,
    canal: CanalDelTiempoEsperado,
    ahora: Date,
  ): Promise<HistoriaDeRespuestas> {
    const clave = claveDelTiempoEsperado(distributorId, canal);
    try {
      const guardada = await this.redis.get(clave);
      if (guardada) return JSON.parse(guardada) as HistoriaDeRespuestas;
    } catch (error) {
      this.logger.warn(
        `Tiempo esperado: no se pudo leer la caché: ${errorMessage(error)}`,
      );
    }
    const historia = await this.calcular(distributorId, canal, ahora);
    try {
      await this.redis.setex(
        clave,
        TTL_DEL_TIEMPO_ESPERADO_SEG,
        JSON.stringify(historia),
      );
    } catch (error) {
      this.logger.warn(
        `Tiempo esperado: no se pudo guardar la caché: ${errorMessage(error)}`,
      );
    }
    return historia;
  }

  /**
   * Las del canal creadas en los últimos 14 días, en minutos hábiles: las
   * respondidas con su primera respuesta y las abiertas que esperan con lo
   * que llevan esperando.
   */
  private async calcular(
    distributorId: string,
    canal: CanalDelTiempoEsperado,
    ahora: Date,
  ): Promise<HistoriaDeRespuestas> {
    const [a, filas] = await Promise.all([
      this.ajustes.leer(distributorId),
      this.lectura.conversacionesDelPeriodo(distributorId, [canal], {
        desde: new Date(ahora.getTime() - DIAS_DEL_TIEMPO_ESPERADO * DIA_MS),
        hasta: ahora,
      }),
    ]);
    const horario = horarioDe(a);
    const respondidas: number[] = [];
    const esperas: number[] = [];
    for (const c of filas) {
      if (!c.firstIncomingAt) continue;
      if (c.firstResponseAt) {
        const m = medirEspera(
          {
            desde: c.firstIncomingAt,
            hasta: c.firstResponseAt,
            cerrada: c.status === ConversationStatus.CLOSED,
          },
          horario,
          null,
          ahora,
        );
        if (m.estado === 'respondida') respondidas.push(m.minutos);
      } else if (c.status === ConversationStatus.OPEN) {
        // Espera todavía: entra con lo que lleva esperando (como mínimo).
        esperas.push(minutosHabiles(horario, c.firstIncomingAt, ahora));
      }
    }
    return historiaDeRespuestas(respondidas, esperas);
  }
}
