import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ChequeosService } from './chequeos.service';
import { HealthController } from './health.controller';
import { HistorialRedisStore, HistorialStore } from './historial.store';
import { MuestreoEstadoService } from './muestreo.service';
import { PaginaEstadoService } from './pagina-estado.service';
import { RedisHealthIndicator } from './redis.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    RedisHealthIndicator,
    ChequeosService,
    PaginaEstadoService,
    MuestreoEstadoService,
    { provide: HistorialStore, useClass: HistorialRedisStore },
  ],
})
export class HealthModule {}
