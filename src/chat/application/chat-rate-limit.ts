import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { STATUS_CODES } from 'http';
import { CODIGOS_DE_ERROR } from '../../common/errors/con-codigo';
import { RedisService } from '../../redis/redis.service';

/** Mensajes por minuto y por persona (§7.7). */
export const MENSAJES_POR_MINUTO = 30;
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
   * (que el envío idempotente devuelve sin crear otro) no lo vuelve a consumir.
   */
  async mensaje(userId: string, clientMessageId?: string): Promise<void> {
    if (clientMessageId) {
      const primero = await this.redis.setIfAbsent(
        `chat:cupo:cmid:${userId}:${clientMessageId}`,
        24 * 60 * 60,
      );
      if (!primero) return;
    }
    const n = await this.redis.incrWithExpire(`chat:cupo:msg:${userId}`, 60);
    if (n > MENSAJES_POR_MINUTO) {
      throw demasiados(
        'Estás mandando mensajes muy rápido. Esperá un momento.',
        CODIGOS_DE_ERROR.CHAT_RATE_LIMITED,
      );
    }
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
