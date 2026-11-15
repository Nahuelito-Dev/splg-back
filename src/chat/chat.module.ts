import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailModule } from '../email/email.module';
import { GatewaysModule } from '../gateways/gateways.module';
import { ChatEvents } from './application/chat.events';
import { ChatNotices } from './application/chat-notices';
import { ChatRateLimit } from './application/chat-rate-limit';
import { ChatThreadsService } from './application/chat-threads.service';
import { ChatViewsService } from './application/chat-views.service';
import { ConversationFactory } from './application/conversation-factory';
import { MensajesRepositorio } from './application/mensajes.port';
import { MessageTemplatesService } from './application/message-templates.service';
import { MessageWriter } from './application/message-writer';
import { PlatformChatService } from './application/platform-chat.service';
import { SupportHousekeepingCron } from './application/support-housekeeping.cron';
import { SupportSettingsService } from './application/support-settings.service';
import { SupportSummaryService } from './application/support-summary.service';
import { SupportTicketsService } from './application/support-tickets.service';
import { TicketActivityService } from './application/ticket-activity.service';
import { TicketQueriesService } from './application/ticket-queries.service';
import { TicketState } from './application/ticket-state';
import { ConversationParty } from './entities/conversation-party.entity';
import { ConversationReadState } from './entities/conversation-read-state.entity';
import { Conversation } from './entities/conversation.entity';
import { MessageTemplate } from './entities/message-template.entity';
import { Message } from './entities/message.entity';
import { PlatformSupportSettings } from './entities/platform-support-settings.entity';
import { SupportTicketMessageLink } from './entities/support-ticket-message-link.entity';
import { SupportTicket } from './entities/support-ticket.entity';
import { ChatReadModel } from './infrastructure/chat-read-model';
import { TypeormMensajesRepository } from './infrastructure/typeorm-mensajes.repository';
import { ChatRealtimeListener } from './presentation/chat-realtime.listener';
import { ChatPresenter } from './presentation/chat.presenter';
import { CompanyPlatformChatController } from './presentation/company-platform-chat.controller';
import { CompanyTicketsController } from './presentation/company-tickets.controller';
import { PlatformChatsController } from './presentation/platform-chats.controller';
import { PlatformSupportConfigController } from './presentation/platform-support-config.controller';
import { PlatformTicketsController } from './presentation/platform-tickets.controller';
import {
  CompanySupportSummaryController,
  PlatformSupportSummaryController,
} from './presentation/support-summary.controller';

/**
 * Mensajería (diseño `DISENO-COMUNICACION.md`). Etapa CH1: el núcleo (envío
 * con número por conversación e idempotencia, lectura, tiempo real) y C1, el
 * chat con la plataforma y los tickets de soporte. Núcleo: no depende de un
 * módulo contratado.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Conversation,
      ConversationParty,
      ConversationReadState,
      Message,
      SupportTicket,
      SupportTicketMessageLink,
      MessageTemplate,
      PlatformSupportSettings,
    ]),
    GatewaysModule,
    EmailModule,
  ],
  controllers: [
    CompanyPlatformChatController,
    CompanyTicketsController,
    PlatformChatsController,
    PlatformTicketsController,
    PlatformSupportConfigController,
    CompanySupportSummaryController,
    PlatformSupportSummaryController,
  ],
  providers: [
    { provide: MensajesRepositorio, useClass: TypeormMensajesRepository },
    MessageWriter,
    ConversationFactory,
    ChatThreadsService,
    ChatReadModel,
    ChatViewsService,
    ChatPresenter,
    ChatEvents,
    ChatNotices,
    ChatRateLimit,
    SupportSettingsService,
    SupportSummaryService,
    MessageTemplatesService,
    PlatformChatService,
    SupportTicketsService,
    TicketActivityService,
    TicketQueriesService,
    TicketState,
    SupportHousekeepingCron,
    ChatRealtimeListener,
  ],
})
export class ChatModule {}
