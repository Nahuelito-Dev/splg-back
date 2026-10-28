import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service';
import { EmailController } from './email.controller';
import { UsersModule } from '../users/users.module';
import { RedisModule } from '../redis/redis.module';
import { EmailSenderPort } from './ports/email-sender.port';
import { ResendEmailAdapter } from './infrastructure/resend-email.adapter';
import { EmailTemplateProvider } from './email-template.provider';
import { EnlacesDeLaApp } from './enlaces-de-la-app';
import { BienvenidaListener } from './bienvenida.listener';

@Module({
  imports: [
    ConfigModule,
    UsersModule,
    RedisModule, // rate-limit + cache de links de reset (ver EmailService)
  ],
  controllers: [EmailController],
  providers: [
    EmailService,
    EmailTemplateProvider,
    EnlacesDeLaApp,
    BienvenidaListener,
    { provide: EmailSenderPort, useClass: ResendEmailAdapter },
  ],
  // EmailSenderPort también se exporta: lo usa `fleet` para el aviso de
  // vencimientos a los admins (FleetAlertsCronService), sin pasar por los
  // flujos transaccionales de EmailService (reset, bienvenida).
  exports: [EmailService, EmailSenderPort, EnlacesDeLaApp],
})
export class EmailModule {}
