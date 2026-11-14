import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorModule } from '../distributor/distributor.module';
import { ProcessRun } from './entities/process-run.entity';
import { ProcessRunController } from './process-run.controller';
import { ProcessRunRecorder } from './process-run.recorder';
import { ProcessRunService } from './process-run.service';
import { ProcessRunWatchCron } from './process-run-watch.cron';
import { EmpresasParaProceso } from './empresas-para-proceso';

/**
 * Monitoreo de los procesos automáticos (F31). Global para que el registrador
 * quede instalado apenas arranca la app, sin que cada módulo con un `@Cron` lo
 * importe: `@ConRegistro` lo encuentra solo. También exporta
 * `EmpresasParaProceso`, el recorrido de las empresas de cada proceso.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ProcessRun]), DistributorModule],
  controllers: [ProcessRunController],
  providers: [
    ProcessRunRecorder,
    ProcessRunService,
    ProcessRunWatchCron,
    EmpresasParaProceso,
  ],
  exports: [ProcessRunRecorder, ProcessRunService, EmpresasParaProceso],
})
export class ProcessRunModule {}
