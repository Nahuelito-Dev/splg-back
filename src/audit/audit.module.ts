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
import { ActorEnLaBase } from './data/actor-en-la-base';
import { SesionAuditService } from './data/sesion-audit.service';
import { DataAuditService } from './data/data-audit.service';
import { DataAuditController } from './data/data-audit.controller';
import { DataAuditV2Controller } from './data/data-audit-v2.controller';

/**
 * Registro de auditoría (CU-152 y CU-153). El interceptor es global: toda
 * escritura de la API queda registrada sin que cada módulo tenga que hacer
 * nada. Además, la auditoría de datos (Auditoria, DetalleAuditoria y
 * TipoAccionAuditoria): la escribe un trigger de la base en cada tabla de
 * negocio; acá se le pasa el actor (`ActorEnLaBase`) y se asientan los
 * ingresos a la sesión.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, Audit, AuditDetail, AuditActionType]),
  ],
  controllers: [AuditController, DataAuditController, DataAuditV2Controller],
  providers: [
    AuditService,
    DataAuditService,
    ActorEnLaBase,
    SesionAuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
  ],
  exports: [AuditService, DataAuditService, SesionAuditService],
})
export class AuditModule {}
