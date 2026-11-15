import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { ConexionDelSoporte } from '../../gateways/admin.gateway';

/** Cliente de Redis propio de la presencia (lo arma el módulo). */
export const REDIS_DE_PRESENCIA = Symbol('REDIS_DE_PRESENCIA');

/** Las conexiones del equipo: miembro `userId|socketId`, puntaje = último latido (ms). */
export const CLAVE_DE_PRESENCIA = 'chat:presencia:plataforma';
/** El último estado del soporte que se avisó a las empresas. */
export const CLAVE_DEL_ESTADO_AVISADO = 'chat:soporte:estado-avisado';

/** Cada cuánto cada instancia renueva sus conexiones. */
export const LATIDO_MS = 30_000;
/** Sin latido en este plazo, la conexión ya no cuenta (la instancia murió). */
export const VIGENCIA_MS = 3 * LATIDO_MS;
/** Vida del estado avisado: si nadie lo renueva, el próximo cálculo vuelve a avisar. */
const VIDA_DEL_ESTADO_AVISADO_S = 24 * 60 * 60;

const miembro = (c: ConexionDelSoporte) => `${c.userId}|${c.socketId}`;

/**
 * Presencia del equipo de soporte de la plataforma (D-C26), en Redis para
 * que la vean todas las instancias. Es un conjunto con latido: cada conexión
 * del panel con `plataforma.tickets.ver` queda con la hora de su último
 * latido; al desconectarse sale, y si la instancia muere sin avisar sus
 * conexiones vencen solas a los {@link VIGENCIA_MS}. Se cuenta por persona:
 * dos pestañas de la misma persona son una.
 */
@Injectable()
export class PresenciaDelEquipo implements OnApplicationShutdown {
  constructor(@Inject(REDIS_DE_PRESENCIA) private readonly redis: Redis) {}

  /** Anota (o renueva) esas conexiones con el latido de `ahora`. */
  async marcar(
    conexiones: readonly ConexionDelSoporte[],
    ahora: number = Date.now(),
  ): Promise<void> {
    if (conexiones.length === 0) return;
    await this.redis.zadd(
      CLAVE_DE_PRESENCIA,
      ...conexiones.flatMap((c) => [ahora, miembro(c)]),
    );
  }

  async quitar(conexion: ConexionDelSoporte): Promise<void> {
    await this.redis.zrem(CLAVE_DE_PRESENCIA, miembro(conexion));
  }

  /** Cuántas personas del equipo están conectadas (limpia de paso las vencidas). */
  async personasConectadas(ahora: number = Date.now()): Promise<number> {
    const desde = ahora - VIGENCIA_MS;
    await this.redis.zremrangebyscore(CLAVE_DE_PRESENCIA, '-inf', `(${desde}`);
    const miembros = await this.redis.zrangebyscore(
      CLAVE_DE_PRESENCIA,
      desde,
      '+inf',
    );
    return new Set(miembros.map((m) => m.split('|')[0])).size;
  }

  /**
   * Guarda `estado` como el último avisado y dice si cambió. Es atómico
   * (`SET … GET`): si dos instancias ven el mismo cambio, avisa una sola.
   */
  async cambioElEstado(estado: string): Promise<boolean> {
    const anterior = await this.redis.set(
      CLAVE_DEL_ESTADO_AVISADO,
      estado,
      'EX',
      VIDA_DEL_ESTADO_AVISADO_S,
      'GET',
    );
    return anterior !== estado;
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}
