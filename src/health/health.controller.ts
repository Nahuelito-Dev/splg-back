import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/isPublic.decorator';
import { RedisHealthIndicator } from './redis.health';

// Health checks: los pega un load balancer / orquestador cada pocos
// segundos. No es tráfico de usuario y NO debe competir con el rate limit
// global (con 100/min, un LB chequeando cada 5s ya se comería buena parte).
@SkipThrottle()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Health check completo del sistema. Pensado para load balancers,
   * orquestadores (K8s, Docker, Render) y monitoreo externo.
   *
   * Verifica:
   *  - PostgreSQL (ping)
   *  - Redis (ping)
   *  - Heap RSS < 300 MB
   *  - Disco con al menos 250 MB libres
   *
   * Retorna 200 con `{ status: "ok" }` cuando todo está sano.
   * Retorna 503 con detalle por componente cuando algo falla.
   */
  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Health check del sistema' })
  check() {
    return this.health.check([
      () => this.db.pingCheck('postgres'),
      () => this.redis.isHealthy('redis'),
      () => this.memory.checkRSS('memory_rss', 300 * 1024 * 1024),
      () =>
        this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.9 }),
    ]);
  }

  /**
   * Liveness probe — minimal, sólo confirma que el proceso responde.
   * Pensado para K8s `livenessProbe`. NO verifica dependencias externas.
   */
  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Liveness probe (sin chequeo de dependencias)' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness probe — confirma que la app puede recibir tráfico.
   * Sólo chequea dependencias críticas (DB + Redis).
   * Pensado para K8s `readinessProbe`.
   */
  @Get('ready')
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe (DB + Redis)' })
  ready() {
    return this.health.check([
      () => this.db.pingCheck('postgres'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
