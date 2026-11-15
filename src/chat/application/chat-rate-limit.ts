import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { STATUS_CODES } from 'http';
import { CODIGOS_DE_ERROR } from '../../common/errors/con-codigo';
import { RedisService } from '../../redis/redis.service';

/** Valor de la marca de un `clientMessageId` que ya entró en el cupo. */
const MARCA_ACEPTADA = 'ok';

/** Mensajes por minuto y por persona (§7.7). */
export const MENSAJES_POR_MINUTO = 30;
/** Mensajes por minuto de un cliente o un chofer en una misma conversación (§7.7). */
export const MENSAJES_POR_MINUTO_EN_UNA_CONVERSACION = 10;
/** Tickets por hora y por empresa (§14.4). */
export const TICKETS_POR_HORA = 5;

function demasiados(message: string, code: string): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message,
      error: STATUS_CODES[HttpStatus.TOO_MANY_REQUESTS],
      code,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Cupos propios del chat, en Redis (compartidos entre instancias). La clave
 * lleva la persona o la empresa: el abuso de una no consume el cupo de otra.
 */
@Injectable()
export class ChatRateLimit {
  constructor(private readonly redis: RedisService) {}

  /**
   * Un mensaje nuevo consume cupo; el reintento del mismo `clientMessageId`
   * de un mensaje que YA pasó el cupo (el envío idempotente lo devuelve sin
   * crear otro) no lo vuelve a consumir. La marca del id se pone recién
   * cuando el mensaje entra en el cupo: si da 429, se quita, y el reintento
   * vuelve a contar (si no, reintentar tras un 429 esquivaría el tope).
   */
  async mensaje(
    userId: string,
    clientMessageId?: string,
    conversacion?: string,
  ): Promise<void> {
    const marca = clientMessageId
      ? `chat:cupo:cmid:${userId}:${clientMessageId}`
      : null;
    if (marca) {
      // La marca tiene dos estados: «1» (en curso: otro pedido con el mismo id
      // está mirando el cupo) y «ok» (ya entró). Sólo «ok» saltea el cupo; un
      // reintento simultáneo con la marca en curso no pasa sin contar.
      const primero = await this.redis.setIfAbsent(marca, 24 * 60 * 60);
      if (!primero) {
        if ((await this.redis.get(marca)) === MARCA_ACEPTADA) return;
        throw demasiados(
          'Ese mensaje ya se está enviando. Esperá un momento.',
          CODIGOS_DE_ERROR.CHAT_RATE_LIMITED,
        );
      }
    }
    try {
      const n = await this.redis.incrWithExpire(`chat:cupo:msg:${userId}`, 60);
      if (n > MENSAJES_POR_MINUTO) {
        throw demasiados(
          'Estás mandando mensajes muy rápido. Esperá un momento.',
          CODIGOS_DE_ERROR.CHAT_RATE_LIMITED,
        );
      }
      // El cliente y el chofer, además, por conversación (la clave lleva la
      // conversación o el tema: el abuso en una no gasta el cupo de otra).
      if (conversacion) {
        const enEsta = await this.redis.incrWithExpire(
          `chat:cupo:conv:${conversacion}:${userId}`,
          60,
        );
        if (enEsta > MENSAJES_POR_MINUTO_EN_UNA_CONVERSACION) {
          throw demasiados(
            'Estás mandando mensajes muy rápido. Esperá un momento.',
            CODIGOS_DE_ERROR.CHAT_RATE_LIMITED,
          );
        }
      }
    } catch (error) {
      if (marca) await this.redis.del(marca);
      throw error;
    }
    if (marca) await this.redis.setex(marca, 24 * 60 * 60, MARCA_ACEPTADA);
  }

  async ticket(distributorId: string): Promise<void> {
    const n = await this.redis.incrWithExpire(
      `chat:cupo:ticket:${distributorId}`,
      60 * 60,
    );
    if (n > TICKETS_POR_HORA) {
      throw demasiados(
        'Ya abriste muchos tickets en la última hora. Esperá un momento o escribinos por el chat.',
        CODIGOS_DE_ERROR.TICKET_RATE_LIMITED,
      );
    }
  }
}
