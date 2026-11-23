import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { RedisHealthIndicator } from './redis.health';
import {
  COMPONENTES,
  EstadoComponente,
  EstadoDeComponentes,
} from './componentes';

type DetalleTerminus = Record<string, { status?: string }>;

/**
 * Los chequeos de `/health`: los usa el endpoint (JSON de Terminus) y el
 * muestreo de la página de estado, así que los dos ven lo mismo.
 */
@Injectable()
export class ChequeosService {
  /** RSS máxima antes de reportar `down` (H-53: 300 MB fijo era el de un
   * proceso recién levantado; con tráfico real lo pasa de largo y un load
   * balancer sacaba de servicio una instancia sana). Configurable por env,
   * con default documentado en `.env.example`. */
  private readonly memoryRssThresholdBytes: number;

  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    config: ConfigService,
  ) {
    const thresholdMb = config.getOrThrow<number>(
      'HEALTH_MEMORY_RSS_THRESHOLD_MB',
    );
    this.memoryRssThresholdBytes = thresholdMb * 1024 * 1024;
  }

  /** Health check completo: lanza 503 (`ServiceUnavailableException`) si algo falla. */
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.pingCheck('postgres'),
      () => this.redis.isHealthy('redis'),
      () => this.memory.checkRSS('memory_rss', this.memoryRssThresholdBytes),
      () =>
        this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.9 }),
    ]);
  }

  /** Igual que `check`, pero nunca lanza: devuelve el estado de cada componente. */
  async estados(): Promise<EstadoDeComponentes> {
    let detalle: DetalleTerminus = {};
    try {
      detalle = (await this.check()).details as DetalleTerminus;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        const cuerpo = error.getResponse() as { details?: DetalleTerminus };
        detalle = cuerpo.details ?? {};
      }
    }
    const estados = {} as EstadoDeComponentes;
    for (const componente of COMPONENTES) {
      const estado: EstadoComponente =
        componente === 'api' || detalle[componente]?.status === 'up'
          ? 'up'
          : 'down';
      estados[componente] = estado;
    }
    return estados;
  }
}
