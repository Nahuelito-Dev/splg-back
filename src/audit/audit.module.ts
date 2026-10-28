import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';
import { Audit } from './entities/audit.entity';
import { AuditDetail } from './entities/audit-detail.entity';
import { AuditActionType } from './entities/audit-action-type.entity';
import { AuditContextInterceptor } from './data/audit-context.interceptor';
import { DataAuditSubscriber } from './data/data-audit.subscriber';
import { DataAuditService } from './data/data-audit.service';
import { DataAuditController } from './data/data-audit.controller';

/**
 * Registro de auditoría (CU-152 y CU-153). El interceptor es global: toda
 * escritura de la API queda registrada sin que cada módulo tenga que hacer
 * nada. Además, la auditoría de datos (Auditoria, DetalleAuditoria y
 * TipoAccionAuditoria): el subscriber global registra cada cambio de una
 * entidad de negocio dentro de su transacción.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, Audit, AuditDetail, AuditActionType]),
  ],
  controllers: [AuditController, DataAuditController],
  providers: [
    AuditService,
    DataAuditService,
    DataAuditSubscriber,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
  ],
  exports: [AuditService, DataAuditService],
})
export class AuditModule {}
