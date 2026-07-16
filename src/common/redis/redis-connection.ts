import { RedisOptions } from 'ioredis';

/**
 * Config de conexión Redis ÚNICA, compartida por todos los consumidores
 * (RedisService para locks/GEO, el adapter de Socket.io, el storage del
 * throttler). Antes cada uno armaba su propia config y podían divergir (host/
 * password distintos) → locks/GEO/pubsub apuntando a instancias diferentes.
 * Con esta factory todos usan EXACTAMENTE la misma instancia.
 *
 * No depende de ConfigService a propósito: la usa también el adapter de
 * Socket.io, que se instancia en `main.ts` fuera del contexto de DI.
 */
export function redisConnectionOptions(): RedisOptions {
  const password = process.env.REDIS_PASSWORD;
  const useTls = process.env.REDIS_TLS === 'true';
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    ...(password ? { password } : {}),
    ...(useTls ? { tls: {} } : {}),
  };
}
