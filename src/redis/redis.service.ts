import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RedisService');
  private client: Redis;

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
  }

  onModuleDestroy() {
    this.client.disconnect();
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
