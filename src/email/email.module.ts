// src/email/email.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailService } from './email.service';
import { EmailController } from './email.controller';
import { UsersModule } from '../users/users.module';
import { RedisModule } from '../redis/redis.module';
import { EmailSenderPort } from './ports/email-sender.port';
import { ResendEmailAdapter } from './infrastructure/resend-email.adapter';
import { EmailTemplateProvider } from './email-template.provider';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => UsersModule), // ← CORRECTO
    RedisModule, // rate-limit + cache de links de reset (ver EmailService)
  ],
  controllers: [EmailController],
  providers: [
    EmailService,
    EmailTemplateProvider,
    { provide: EmailSenderPort, useClass: ResendEmailAdapter },
  ],
  exports: [EmailService],
})
export class EmailModule {}
