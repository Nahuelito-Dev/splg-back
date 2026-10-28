import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { EmailModule } from '../email/email.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationsListener } from './admin-notifications.listener';
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminNotification } from './entities/admin-notification.entity';
import { AdminNotificationRead } from './entities/admin-notification-read.entity';

/**
 * Bandeja de avisos de los administradores. Cualquier módulo emite
 * `EVENTO_NOTIFICAR_ADMIN` y este módulo lo guarda, lo empuja al panel y, si el
 * aviso lo pide, lo manda por correo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AdminNotification, AdminNotificationRead]),
    // Los correos van a los admins activos de la distribuidora.
    AdminModule,
    EmailModule,
    // Aviso en vivo al panel.
    GatewaysModule,
  ],
  controllers: [AdminNotificationsController],
  providers: [AdminNotificationsService, AdminNotificationsListener],
})
export class AdminNotificationsModule {}
