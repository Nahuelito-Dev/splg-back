import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import Redlock, { Lock } from 'redlock';
import { redisConnectionOptions } from '../common/redis/redis-connection';
import { errorMessage } from '../common/errors/error-message';

/** Cuánto espera el health check la respuesta de Redis antes de darlo por caído. */
const PING_TIMEOUT_MS = 2000;

/** Reintentos de `withLock` con espera: cada cuánto y cuánto jitter. */
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_RETRY_JITTER_MS = 50;

/** Vigencia de la hora de la última ubicación del chofer. */
const LOCATION_AT_TTL_SEC = 24 * 60 * 60;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisService');
  private client!: Redis;
  private redlock!: Redlock;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.client = new Redis(redisConnectionOptions());

    this.client.on('connect', () =>
      this.logger.log('✅ Redis Client Conectado'),
    );
    this.client.on('error', (err) =>
      this.logger.error(`❌ Redis Error: ${err}`),
    );

    // Redlock para distributed locks. Una sola instancia de Redis es OK para
    // este caso de uso (cron de despacho) — para alta disponibilidad real
    // se necesitarían 3+ Redis independientes según el algoritmo Redlock.
    this.redlock = new Redlock([this.client], {
      driftFactor: 0.01,
      retryCount: 0, // si otro pod tiene el lock, devolvemos null y skip
      automaticExtensionThreshold: 500,
    });

    // Evita unhandled rejection si el lock expira por timeout
    this.redlock.on('error', (err: Error) => {
      this.logger.warn(`Redlock error: ${err.message}`);
    });
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  /**
   * Adquiere un lock distribuido sobre `key`. Devuelve null si otro proceso
   * ya lo tiene (no espera, no reintenta). Pensado para crons distribuidos
   * y secciones críticas que NO deben correr en paralelo en multi-instancia.
   *
   * @param key  Identificador semántico del recurso (ej: 'dispatch:pending')
   * @param ttlMs Tiempo máximo del lock en ms. Si el proceso crashea sin
   *              liberar, el lock expira solo. Debe ser mayor al tiempo
   *              estimado de la operación pero menor al próximo trigger.
   */
  async acquireLock(key: string, ttlMs = 30000): Promise<Lock | null> {
    try {
      return await this.redlock.acquire([`lock:${key}`], ttlMs);
    } catch {
      // El error típico es LockError (otro proceso lo tiene). No es excepcional.
      return null;
    }
  }

  /**
   * Cache genérico get. Retorna null si la key no existe o expiró.
   * Usado por el interceptor de idempotencia y caches del dominio.
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Cache genérico SET con TTL en segundos (SETEX).
   * Idempotente: sobrescribe si ya existe.
   */
  async setex(key: string, ttlSec: number, value: string): Promise<void> {
    await this.client.setex(key, ttlSec, value);
  }

  /**
   * Borra una key. Útil para invalidar caches al modificar la entidad.
   */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Ejecuta `fn` bajo un lock distribuido sobre `key` con extensión automática
   * (Redlock `using`): mientras `fn` corre, el lock se renueva solo, así la
   * sección crítica nunca excede su vigencia. Si otro proceso tiene el lock,
   * no ejecuta `fn` y devuelve `{ obtenido: false }`; los errores de `fn` se
   * propagan. Con `esperaMaxMs` reintenta (con jitter) hasta ese plazo antes de
   * rendirse; sin él no espera.
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
    esperaMaxMs = 0,
  ): Promise<{ obtenido: true; valor: T } | { obtenido: false }> {
    let ejecutando = false;
    let resultado: { valor: T } | undefined;
    let falloLaOperacion = false;
    let error: unknown;
    try {
      const seccion = async () => {
        ejecutando = true;
        // Lo que falle acá es de la operación; lo que falle después (renovar o
        // soltar el lock) no puede pisar su resultado.
        try {
          resultado = { valor: await fn() };
        } catch (e) {
          falloLaOperacion = true;
          error = e;
        }
      };
      const recurso = [`lock:${key}`];
      if (esperaMaxMs > 0) {
        await this.redlock.using(
          recurso,
          ttlMs,
          {
            retryCount: Math.ceil(esperaMaxMs / LOCK_RETRY_DELAY_MS),
            retryDelay: LOCK_RETRY_DELAY_MS,
            retryJitter: LOCK_RETRY_JITTER_MS,
          },
          seccion,
        );
      } else {
        await this.redlock.using(recurso, ttlMs, seccion);
      }
    } catch (err) {
      // Sin lock (otro proceso lo tiene): no es un error.
      if (!ejecutando) return { obtenido: false };
      // La operación ya corrió: un error al renovar o soltar el lock se
      // registra, pero no se convierte en un 500 de una operación confirmada.
      this.logger.warn(
        `Redlock: falló al renovar o soltar el lock "${key}": ${errorMessage(err)}`,
      );
    }
    if (falloLaOperacion) throw error;
    if (!resultado) return { obtenido: false };
    return { obtenido: true, valor: resultado.valor };
  }

  /**
   * SET NX con TTL en segundos: marca `key` sólo si no existía. Devuelve true
   * si la creó (el caller es el primero), false si ya estaba.
   */
  async setIfAbsent(key: string, ttlSec: number): Promise<boolean> {
    const res = await this.client.set(key, '1', 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  /**
   * Incrementa un contador y le pone TTL de `windowSec` la PRIMERA vez que
   * se crea (no lo resetea en cada incremento). Patrón "fixed window" para
   * rate-limiting distribuido: todas las instancias comparten el mismo
   * contador en vez de un `Map` en memoria por pod.
   *
   * Devuelve el valor del contador después de incrementar. El caller decide
   * el umbral (ej. `if (count > MAX) throw ...`).
   */
  async incrWithExpire(key: string, windowSec: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSec);
    }
    return count;
  }

  /**
   * Verifica que el cliente Redis responda. Usado por el health check.
   * No lanza: retorna false si la conexión no responde.
   */
  async ping(): Promise<boolean> {
    try {
      // Con Redis caído el cliente encola el comando y reintenta: sin un tope,
      // el health check se colgaba hasta el timeout de la request (2 min).
      let temporizador: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        this.client.ping(),
        new Promise<null>((resolve) => {
          temporizador = setTimeout(() => resolve(null), PING_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(temporizador));
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  // --- TRACKING: pedido activo por chofer ---
  // Mapea el user_id del chofer → { orderId, customerId } mientras entrega. Sirve
  // para que, al recibir su GPS, sepamos a qué cliente reenviar la ubicación sin
  // tocar la DB en cada ping. TTL de seguridad por si no se limpia al entregar.

  private driverActiveOrderKey(driverUserId: string): string {
    return `driver:active-order:${driverUserId}`;
  }

  async setDriverActiveOrder(
    driverUserId: string,
    data: {
      orderId: string;
      customerId: string;
      distributorId?: string | null;
    },
    ttlSec = 3 * 60 * 60,
  ): Promise<void> {
    await this.setex(
      this.driverActiveOrderKey(driverUserId),
      ttlSec,
      JSON.stringify(data),
    );
  }

  async getDriverActiveOrder(driverUserId: string): Promise<{
    orderId: string;
    customerId: string;
    distributorId?: string | null;
  } | null> {
    const raw = await this.get(this.driverActiveOrderKey(driverUserId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as {
        orderId: string;
        customerId: string;
        distributorId?: string | null;
      };
    } catch {
      return null;
    }
  }

  async clearDriverActiveOrder(driverUserId: string): Promise<void> {
    await this.del(this.driverActiveOrderKey(driverUserId));
  }

  // --- MÉTODOS DEL RADAR (REQ 4.3.2 y 4.4.2) ---

  /**
   * Guarda la ubicación actual de un chofer
   * Comando: GEOADD drivers:locations longitude latitude member
   */
  async updateDriverLocation(driverId: string, lat: number, lng: number) {
    // Redis usa formato: Longitud, Latitud, ID
    // El key 'drivers:locations' es donde se guardan todos
    await this.client.geoadd('drivers:locations', lng, lat, driverId);
    // El radar guarda la posición pero no cuándo: se anota aparte (vence a las
    // 24 h) para poder decir "última ubicación conocida de las HH:MM".
    await this.client.setex(
      this.driverLocationAtKey(driverId),
      LOCATION_AT_TTL_SEC,
      new Date().toISOString(),
    );

    // Opcional: Guardar metadata extra si la necesitas (ej: estado) en un hash separado
    // await this.client.hset(`driver:${driverId}:info`, 'status', 'AVAILABLE');
  }

  /**
   * Busca choferes cercanos a un punto
   * Comando: GEORADIUS drivers:locations longitude latitude radius unit ...
   */
  async getNearbyDrivers(
    lat: number,
    lng: number,
    radiusKm: number = 5,
  ): Promise<string[]> {
    // Busca en un radio de X km
    // WITHDIST: Devuelve la distancia
    // ASC: Ordena del más cercano al más lejano (¡Ideal para tu asignación!)
    const results = await this.client.georadius(
      'drivers:locations',
      lng,
      lat,
      radiusKm,
      'km',
      'ASC',
    );

    // results viene como array de IDs si no pedimos detalles, o array de arrays si pedimos distancia.
    // Por simplicidad en Fase 1, solo devolvemos los IDs de los choferes encontrados.
    return results as string[];
  }

  /**
   * Elimina a un chofer del radar (ej: se desconecta)
   */
  async removeDriver(driverId: string) {
    await this.client.zrem('drivers:locations', driverId);
    await this.client.del(this.driverLocationAtKey(driverId));
  }

  /**
   * Última posición conocida de un chofer en el radar, con el momento en que se
   * registró (`at`, ISO; `null` si la posición es de antes de que se anotara).
   * `null` si no está en el radar.
   */
  async getDriverLastLocation(
    driverId: string,
  ): Promise<{ lat: number; lng: number; at: string | null } | null> {
    const [pos] = await this.client.geopos('drivers:locations', driverId);
    if (!pos) return null;
    const at = await this.client.get(this.driverLocationAtKey(driverId));
    return { lat: Number(pos[1]), lng: Number(pos[0]), at };
  }

  private driverLocationAtKey(driverId: string): string {
    return `driver:location-at:${driverId}`;
  }
}
