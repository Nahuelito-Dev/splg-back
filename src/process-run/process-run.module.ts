import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorModule } from '../distributor/distributor.module';
import { AdminNotification } from '../admin-notifications/entities/admin-notification.entity';
import { ProcessRun } from './entities/process-run.entity';
import { ProcessRunController } from './process-run.controller';
import { ProcessRunRecorder } from './process-run.recorder';
import { ProcessRunService } from './process-run.service';
import { ProcessRunWatchCron } from './process-run-watch.cron';
import { EmpresasParaProceso } from './empresas-para-proceso';
import { RachasDeFallas } from './rachas-de-fallas';

/**
 * Monitoreo de los procesos automáticos (F31). Global para que el registrador
 * quede instalado apenas arranca la app, sin que cada módulo con un `@Cron` lo
 * importe: `@ConRegistro` lo encuentra solo. También exporta
 * `EmpresasParaProceso`, el recorrido de las empresas de cada proceso.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ProcessRun, AdminNotification]),
    DistributorModule,
  ],
  controllers: [ProcessRunController],
  providers: [
    ProcessRunRecorder,
    ProcessRunService,
    ProcessRunWatchCron,
    EmpresasParaProceso,
    RachasDeFallas,
  ],
  exports: [ProcessRunRecorder, ProcessRunService, EmpresasParaProceso],
})
export class ProcessRunModule {}
