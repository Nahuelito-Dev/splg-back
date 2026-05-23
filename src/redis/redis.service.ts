import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import Redlock, { Lock } from 'redlock';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisService');
  private client: Redis;
  private redlock: Redlock;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.configService.get('REDIS_HOST') || 'localhost',
      port: parseInt(this.configService.get('REDIS_PORT') || '6379'),
      // password: this.configService.get('REDIS_PASSWORD'), // Descomentar si usas pass
    });

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
    this.redlock.on('error', (err) => {
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
   * Verifica que el cliente Redis responda. Usado por el health check.
   * No lanza: retorna false si la conexión no responde.
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
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
  }
}
