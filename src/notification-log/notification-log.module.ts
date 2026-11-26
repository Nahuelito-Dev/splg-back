import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationLog } from './entities/notification-log.entity';
import {
  NotificationLogController,
  OrderNotificationsController,
} from './notification-log.controller';
import { NotificationLogRecorder } from './notification-log.recorder';
import { NotificationLogService } from './notification-log.service';

/**
 * Registro de avisos enviados. Global porque los adaptadores de push y de
 * correo (`FcmAdapter`, `ResendEmailAdapter`) lo usan desde sus módulos, que
 * son globales o compartidos, sin que cada uno lo importe.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([NotificationLog])],
  controllers: [NotificationLogController, OrderNotificationsController],
  providers: [NotificationLogRecorder, NotificationLogService],
  exports: [NotificationLogRecorder],
})
export class NotificationLogModule {}
