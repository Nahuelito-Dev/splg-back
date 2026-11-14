import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DistributorModule } from '../distributor/distributor.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { SupportEndedNotice } from './application/support-ended.notice';
import { SupportAccessService } from './application/support-access.service';
import { SupportNotices } from './application/support-notices';
import { SupportSessionCache } from './application/support-session.cache';
import { SupportSessionExpiryCron } from './application/support-session-expiry.cron';
import { SupportSessionResolver } from './application/support-session.resolver';
import { SupportSessionsService } from './application/support-sessions.service';
import { SupportAccess } from './entities/support-access.entity';
import { SupportSession } from './entities/support-session.entity';
import { SupportAccessController } from './presentation/support-access.controller';
import { SupportSessionsController } from './presentation/support-sessions.controller';

/**
 * Modo soporte del administrador general (E1): sesiones con motivo,
 * aprobación de la empresa o emergencia, vencimiento y revocación. Exporta el
 * resolvedor que usa `AuthGuard` para validar `X-Support-Session`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SupportSession, SupportAccess]),
    DistributorModule,
    GatewaysModule,
  ],
  controllers: [SupportSessionsController, SupportAccessController],
  providers: [
    SupportSessionsService,
    SupportAccessService,
    SupportSessionCache,
    SupportSessionResolver,
    SupportNotices,
    SupportSessionExpiryCron,
    SupportEndedNotice,
  ],
  exports: [SupportSessionResolver],
})
export class SupportModule {}
