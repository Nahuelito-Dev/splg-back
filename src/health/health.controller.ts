import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/isPublic.decorator';
import { ChequeosService } from './chequeos.service';
import { PaginaEstadoService } from './pagina-estado.service';
import { cspDePagina, renderPaginaEstado } from './pagina-estado.html';
import { RedisHealthIndicator } from './redis.health';

/** Esquema de la respuesta de Terminus (`HealthCheckResult`). */
function esquemaHealth(status: 'ok' | 'error') {
  const indicadores = {
    type: 'object',
    additionalProperties: {
      type: 'object',
      properties: { status: { type: 'string', example: 'up' } },
      additionalProperties: { type: 'string' },
    },
  };
  return {
    type: 'object',
    properties: {
      status: { type: 'string', example: status },
      info: { ...indicadores, nullable: true },
      error: { ...indicadores, nullable: true },
      details: indicadores,
    },
  };
}

// Health checks: los pega un load balancer / orquestador cada pocos
// segundos. No es tráfico de usuario y NO debe competir con el rate limit
// global (con 100/min, un LB chequeando cada 5s ya se comería buena parte).
@SkipThrottle()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly chequeos: ChequeosService,
    private readonly pagina: PaginaEstadoService,
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Health check completo del sistema. Pensado para load balancers,
   * orquestadores (K8s, Docker, Render) y monitoreo externo.
   *
   * Verifica:
   *  - PostgreSQL (ping)
   *  - Redis (ping)
   *  - RSS < `HEALTH_MEMORY_RSS_THRESHOLD_MB` (default 512 MB)
   *  - Disco con al menos 250 MB libres
   *
   * Retorna 200 con `{ status: "ok" }` cuando todo está sano.
   * Retorna 503 con detalle por componente cuando algo falla.
   *
   * Un navegador (`Accept` que prefiere `text/html`) recibe la página de
   * estado, con el mismo código HTTP (200 o 503). Con `?format=json` o sin
   * `Accept: text/html` la respuesta es el JSON de siempre.
   */
  @Get()
  @Public()
  // La documentación de Swagger se arma acá (no la de Terminus): la suya pisa
  // la respuesta 200 y dejaría afuera la representación HTML.
  @HealthCheck({ noCache: true, swaggerDocumentation: false })
  @ApiOperation({
    summary: 'Health check del sistema (JSON) y página de estado (HTML)',
  })
  @ApiProduces('application/json', 'text/html')
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['json'],
    description: 'Con `json` fuerza el JSON aunque el cliente prefiera HTML.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Todo sano. JSON de Terminus; con `Accept: text/html`, la página de estado.',
    content: {
      'application/json': { schema: esquemaHealth('ok') },
      'text/html': { schema: { type: 'string' } },
    },
  })
  @ApiResponse({
    status: 503,
    description:
      'Algo caído. JSON de Terminus con el detalle; con `Accept: text/html`, la página de estado.',
    content: {
      'application/json': { schema: esquemaHealth('error') },
      'text/html': { schema: { type: 'string' } },
    },
  })
  async check(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('format') format?: string,
  ): Promise<HealthCheckResult | string> {
    res.vary('Accept');
    const quiereHtml =
      format !== 'json' && req.accepts(['json', 'html']) === 'html';
    if (!quiereHtml) return this.chequeos.check();

    const modelo = await this.pagina.modelo();
    const nonce = randomBytes(16).toString('base64');
    res.status(modelo.general === 'ok' ? 200 : 503);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=15');
    res.setHeader('Content-Security-Policy', cspDePagina(nonce));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return renderPaginaEstado(modelo, nonce);
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
