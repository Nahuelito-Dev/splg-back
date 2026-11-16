import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../../common/errors/error-message';
import type { SesionDeSoporteEnCurso } from '../../common/types/sesion-de-soporte';
import { RedisService } from '../../redis/redis.service';

/** Tope de la caché de una sesión activa, en segundos. */
export const TTL_MAXIMO_DE_LA_CACHE_SEG = 30;

/** Lo que se guarda: la sesión en curso y de quién es. */
interface EnCache {
  id: string;
  requestedBy: string;
  distributorId: string;
  scope: string[];
  expiresAt: string;
}

export const claveDeSesion = (id: string): string => `soporte:sesion:${id}`;

/**
 * Caché de las sesiones ACTIVAS, para no ir a la base en cada request de
 * soporte. Dura `min(30 s, lo que le falta a la sesión)`: nunca extiende una
 * sesión. Se borra al finalizar, revocar o vencer, así la revocación vale en la
 * request siguiente. Si Redis falla, se consulta la base (best-effort).
 */
@Injectable()
export class SupportSessionCache {
  private readonly logger = new Logger(SupportSessionCache.name);

  constructor(private readonly redis: RedisService) {}

  async leer(
    id: string,
  ): Promise<(SesionDeSoporteEnCurso & { requestedBy: string }) | null> {
    try {
      const crudo = await this.redis.get(claveDeSesion(id));
      if (!crudo) return null;
      const c = JSON.parse(crudo) as EnCache;
      return {
        id: c.id,
        requestedBy: c.requestedBy,
        distributorId: c.distributorId,
        scope: c.scope,
        expiresAt: new Date(c.expiresAt),
      };
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la sesión de soporte ${id} de la caché: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  async guardar(
    sesion: SesionDeSoporteEnCurso & { requestedBy: string },
    ahora: Date = new Date(),
  ): Promise<void> {
    const restante = Math.floor(
      (sesion.expiresAt.getTime() - ahora.getTime()) / 1000,
    );
    const ttl = Math.min(TTL_MAXIMO_DE_LA_CACHE_SEG, restante);
    if (ttl < 1) return;
    const valor: EnCache = {
      id: sesion.id,
      requestedBy: sesion.requestedBy,
      distributorId: sesion.distributorId,
      scope: sesion.scope,
      expiresAt: sesion.expiresAt.toISOString(),
    };
    try {
      await this.redis.setex(
        claveDeSesion(sesion.id),
        ttl,
        JSON.stringify(valor),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar la sesión de soporte ${sesion.id} en la caché: ${errorMessage(error)}`,
      );
    }
  }

  async olvidar(id: string): Promise<void> {
    try {
      await this.redis.del(claveDeSesion(id));
    } catch (error) {
      // Sin Redis no hay caché que olvidar en las otras instancias: la entrada
      // vieja vence sola en, a lo sumo, 30 segundos.
      this.logger.warn(
        `No se pudo borrar la sesión de soporte ${id} de la caché: ${errorMessage(error)}`,
      );
    }
  }
}
