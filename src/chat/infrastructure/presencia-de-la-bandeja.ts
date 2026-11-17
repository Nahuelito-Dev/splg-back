import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  LATIDO_MS,
  REDIS_DE_PRESENCIA,
  VIGENCIA_MS,
} from './presencia-del-equipo';

/** Una conexión del panel de alguien del equipo de una empresa que atiende la bandeja. */
export interface ConexionDeLaBandeja {
  distributorId: string;
  userId: string;
  socketId: string;
}

/** Lo que se sabe de la conexión de una persona. */
export interface ConexionDeLaPersona {
  /** Tiene al menos una pestaña del panel abierta (con latido vigente). */
  conectado: boolean;
  /** La última vez que se la vio conectada (ms); `null` si nunca o hace más de un día. */
  vistoEn: number | null;
}

/** Vida de las marcas de «visto»: más que eso no le importa a nadie. */
const VIDA_DE_VISTO_S = 24 * 60 * 60;
/** Vida del último estado avisado de cada persona (como el del soporte). */
const VIDA_DEL_ESTADO_AVISADO_S = 24 * 60 * 60;

const clave = (distributorId: string) =>
  `chat:presencia:empresa:${distributorId}`;
const claveDeVistos = (distributorId: string) =>
  `chat:presencia:empresa:${distributorId}:vistos`;
const claveDelAvisado = (distributorId: string, userId: string) =>
  `chat:equipo:avisado:${distributorId}:${userId}`;
const miembro = (c: ConexionDeLaBandeja) => `${c.userId}|${c.socketId}`;

/**
 * Presencia del equipo de cada empresa en la bandeja (tanda 8b), en Redis
 * para que la vean todas las instancias. El mismo esquema que la del soporte
 * de la plataforma (`PresenciaDelEquipo`, con su cliente de Redis): un
 * conjunto con latido por empresa (`userId|socketId` → último latido) y, por
 * persona, cuándo se la vio conectada por última vez (para la gracia de dos
 * minutos de una desconexión). Las conexiones de una instancia caída vencen
 * solas a los {@link VIGENCIA_MS}.
 */
@Injectable()
export class PresenciaDeLaBandeja {
  constructor(@Inject(REDIS_DE_PRESENCIA) private readonly redis: Redis) {}

  /** Anota (o renueva) esas conexiones con el latido de `ahora`. */
  async marcar(
    conexiones: readonly ConexionDeLaBandeja[],
    ahora: number = Date.now(),
  ): Promise<void> {
    const porEmpresa = new Map<string, ConexionDeLaBandeja[]>();
    for (const c of conexiones) {
      porEmpresa.set(c.distributorId, [
        ...(porEmpresa.get(c.distributorId) ?? []),
        c,
      ]);
    }
    for (const [d, propias] of porEmpresa) {
      await this.redis.zadd(
        clave(d),
        ...propias.flatMap((c) => [ahora, miembro(c)]),
      );
      await this.redis.zadd(
        claveDeVistos(d),
        ...propias.flatMap((c) => [ahora, c.userId]),
      );
      await this.redis.expire(claveDeVistos(d), VIDA_DE_VISTO_S);
      await this.redis.expire(clave(d), VIDA_DE_VISTO_S);
    }
  }

  /** Se cerró una pestaña: sale del conjunto y queda «vista» ahora (empieza la gracia). */
  async quitar(
    conexion: ConexionDeLaBandeja,
    ahora: number = Date.now(),
  ): Promise<void> {
    await this.redis.zrem(clave(conexion.distributorId), miembro(conexion));
    await this.redis.zadd(
      claveDeVistos(conexion.distributorId),
      ahora,
      conexion.userId,
    );
  }

  /** La conexión de cada persona de la empresa (las vencidas se limpian de paso). */
  async deLaEmpresa(
    distributorId: string,
    ahora: number = Date.now(),
  ): Promise<Map<string, ConexionDeLaPersona>> {
    const desde = ahora - VIGENCIA_MS;
    await this.redis.zremrangebyscore(
      clave(distributorId),
      '-inf',
      `(${desde}`,
    );
    const vivos = await this.redis.zrangebyscore(
      clave(distributorId),
      desde,
      '+inf',
    );
    const vistos = await this.redis.zrange(
      claveDeVistos(distributorId),
      0,
      -1,
      'WITHSCORES',
    );
    const r = new Map<string, ConexionDeLaPersona>();
    for (let i = 0; i + 1 < vistos.length; i += 2) {
      r.set(vistos[i], { conectado: false, vistoEn: Number(vistos[i + 1]) });
    }
    for (const m of vivos) {
      const userId = m.split('|')[0];
      r.set(userId, {
        conectado: true,
        vistoEn: r.get(userId)?.vistoEn ?? ahora,
      });
    }
    return r;
  }

  /**
   * Guarda `estado` como el último avisado de esa persona y dice si cambió.
   * Atómico (`SET … GET`): si dos instancias ven el mismo cambio, avisa una.
   */
  async cambioElEstado(
    distributorId: string,
    userId: string,
    estado: string,
  ): Promise<boolean> {
    const anterior = await this.redis.set(
      claveDelAvisado(distributorId, userId),
      estado,
      'EX',
      VIDA_DEL_ESTADO_AVISADO_S,
      'GET',
    );
    return anterior !== estado;
  }
}

/** Cada cuánto cada instancia renueva las conexiones de la bandeja (el mismo latido que el soporte). */
export const LATIDO_DE_LA_BANDEJA_MS = LATIDO_MS;
