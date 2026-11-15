import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminNotification } from '../admin-notifications/entities/admin-notification.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { ProcessRun } from '../process-run/entities/process-run.entity';
import { TrazasController } from './traza/trazas.controller';
import { TrazasService } from './traza/trazas.service';

/**
 * Observabilidad de la plataforma (DISENO-OBSERVABILIDAD): por ahora, la
 * traza de punta a punta (O1). La huella de errores vive en `errores/` y la
 * usa el registrador de corridas.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, ProcessRun, AdminNotification]),
  ],
  controllers: [TrazasController],
  providers: [TrazasService],
})
export class ObservabilityModule {}
