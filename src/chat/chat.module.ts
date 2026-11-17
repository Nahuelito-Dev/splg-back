import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConnectionOptions } from '../common/redis/redis-connection';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { S3Module } from '../s3/s3.module';
import { ClaimsModule } from '../claims/claims.module';
import { EmailModule } from '../email/email.module';
import { AsistenteDelChat } from './application/asistente-del-chat';
import { ESCANER_DE_ARCHIVOS } from '../attachment/escaner/escaner.provider';
import { AdjuntosDelChat } from './application/adjuntos-del-chat.service';
import { BandejaAdjuntos } from './application/bandeja-adjuntos.service';
import { EscaneoDeAdjuntos } from './application/escaneo-de-adjuntos';
import { EscaneoDeAdjuntosCron } from './application/escaneo-de-adjuntos.cron';
import { SoporteAdjuntos } from './application/soporte-adjuntos.service';
import { CompanySupportAttachmentsController } from './presentation/adjuntos/company-support-attachments.controller';
import { InboxAttachmentsController } from './presentation/adjuntos/inbox-attachments.controller';
import { MyAttachmentsController } from './presentation/adjuntos/my-attachments.controller';
import { PlatformSupportAttachmentsController } from './presentation/adjuntos/platform-support-attachments.controller';
import { BandejaAcceso } from './application/bandeja-acceso';
import { ChatMetricsService } from './application/chat-metrics.service';
import { PlatformChatMetricsService } from './application/platform-chat-metrics.service';
import { MetricasReadModel } from './infrastructure/metricas-read-model';
import {
  CompanyChatMetricsController,
  PlatformChatMetricsController,
} from './presentation/metricas/chat-metrics.controller';
import { RespuestasFijas } from './application/respuestas-fijas';
import { BandejaEquipoService } from './application/bandeja-equipo.service';
import { BandejaNotasService } from './application/bandeja-notas.service';
import { BandejaEncuestaService } from './application/bandeja-encuesta.service';
import { BandejaGestionService } from './application/bandeja-gestion.service';
import { BandejaSugerenciasService } from './application/bandeja-sugerencias.service';
import { BandejaService } from './application/bandeja.service';
import { ConversacionVigente } from './application/conversacion-vigente';
import { CompanyChatSettingsService } from './application/company-chat-settings.service';
import { CompanyTemplatesService } from './application/company-templates.service';
import { ChatCompanySettings } from './entities/chat-company-settings.entity';
import { ConversationLabel } from './entities/conversation-label.entity';
import { ConversationLabelLink } from './entities/conversation-label-link.entity';
import { ChatLabelsService } from './application/chat-labels.service';
import { TiempoEsperadoService } from './application/tiempo-esperado.service';
import { CierrePorInactividad } from './application/cierre-por-inactividad';
import { CierrePorInactividadCron } from './application/cierre-por-inactividad.cron';
import { CompanyChatLabelsController } from './presentation/bandeja/company-chat-labels.controller';
import { ChatAgentSettings } from './entities/chat-agent-settings.entity';
import { AgentesDeLaBandeja } from './infrastructure/agentes-de-la-bandeja';
import { PresenciaDeLaBandeja } from './infrastructure/presencia-de-la-bandeja';
import { EquipoDeLaBandejaService } from './application/equipo-de-la-bandeja.service';
import { AsignacionAutomaticaService } from './application/asignacion-automatica.service';
import { AsignacionAutomaticaListener } from './application/asignacion-automatica.listener';
import { AsignacionAutomaticaCron } from './application/asignacion-automatica.cron';
import { EstadoDelEquipoService } from './application/estado-del-equipo.service';
import { MyChatStatusController } from './presentation/bandeja/my-chat-status.controller';
import { CompanyChatAgentsController } from './presentation/bandeja/company-chat-agents.controller';
import { MyExpectedReplyController } from './presentation/bandeja/my-expected-reply.controller';
import { MessageEdit } from './entities/message-edit.entity';
import { MessageMention } from './entities/message-mention.entity';
import { ConversationRating } from './entities/conversation-rating.entity';
import { BandejaReadModel } from './infrastructure/bandeja-read-model';
import { BandejaPresenter } from './presentation/bandeja.presenter';
import { BandejaRealtimeListener } from './presentation/bandeja-realtime.listener';
import { CompanyChatConfigController } from './presentation/bandeja/company-chat-config.controller';
import { CompanyInboxController } from './presentation/bandeja/company-inbox.controller';
import { MyConversationsController } from './presentation/bandeja/my-conversations.controller';
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
import { SupportStatusService } from './application/support-status.service';
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
import {
  PresenciaDelEquipo,
  REDIS_DE_PRESENCIA,
} from './infrastructure/presencia-del-equipo';
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
 * Mensajería (diseño `DISENO-COMUNICACION.md`). CH1: el núcleo (envío con
 * número por conversación e idempotencia, lectura, tiempo real) y C1, el chat
 * con la plataforma y los tickets de soporte (núcleo: no depende de un módulo
 * contratado). CH3: la bandeja de la empresa con sus clientes (C3) y sus
 * choferes (C2), atada al módulo `chat`.
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
      MessageEdit,
      MessageMention,
      ConversationRating,
      ChatCompanySettings,
      ConversationLabel,
      ConversationLabelLink,
      ChatAgentSettings,
    ]),
    GatewaysModule,
    EmailModule,
    AdminModule,
    // Crear un reclamo desde una conversación con un cliente (C3).
    ClaimsModule,
    // Las fotos de perfil del personal para asignar (URL firmada) y los
    // adjuntos del chat (CH7).
    S3Module,
  ],
  controllers: [
    CompanyPlatformChatController,
    CompanyTicketsController,
    PlatformChatsController,
    PlatformTicketsController,
    PlatformSupportConfigController,
    CompanySupportSummaryController,
    PlatformSupportSummaryController,
    CompanyInboxController,
    CompanyChatConfigController,
    CompanyChatLabelsController,
    // Asignación automática (8b): el estado propio y el equipo.
    MyChatStatusController,
    CompanyChatAgentsController,
    // Antes que `MyConversationsController`: `me/conversations/:id` no tiene
    // que quedarse con `me/conversations/expected-reply`.
    MyExpectedReplyController,
    MyConversationsController,
    // Adjuntos y escaneo (CH7).
    InboxAttachmentsController,
    MyAttachmentsController,
    CompanySupportAttachmentsController,
    PlatformSupportAttachmentsController,
    // Métricas del chat y del asistente (B4).
    CompanyChatMetricsController,
    PlatformChatMetricsController,
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
    SupportStatusService,
    {
      provide: REDIS_DE_PRESENCIA,
      // Conexión perezosa: se abre con el primer uso (un seed no la abre).
      useFactory: () =>
        new Redis({ ...redisConnectionOptions(), lazyConnect: true }),
    },
    PresenciaDelEquipo,
    MessageTemplatesService,
    PlatformChatService,
    SupportTicketsService,
    TicketActivityService,
    TicketQueriesService,
    TicketState,
    SupportHousekeepingCron,
    ChatRealtimeListener,
    BandejaAcceso,
    BandejaReadModel,
    BandejaPresenter,
    BandejaService,
    // Etiquetas, tiempo de respuesta esperado y cierre por inactividad (7c).
    ChatLabelsService,
    TiempoEsperadoService,
    CierrePorInactividad,
    CierrePorInactividadCron,
    // Asignación automática (8b).
    PresenciaDeLaBandeja,
    AgentesDeLaBandeja,
    EquipoDeLaBandejaService,
    AsignacionAutomaticaService,
    EstadoDelEquipoService,
    AsignacionAutomaticaListener,
    AsignacionAutomaticaCron,
    BandejaGestionService,
    BandejaEquipoService,
    BandejaNotasService,
    BandejaEncuestaService,
    BandejaSugerenciasService,
    CompanyChatSettingsService,
    CompanyTemplatesService,
    BandejaRealtimeListener,
    ConversacionVigente,
    RespuestasFijas,
    AsistenteDelChat,
    ESCANER_DE_ARCHIVOS,
    EscaneoDeAdjuntos,
    EscaneoDeAdjuntosCron,
    AdjuntosDelChat,
    BandejaAdjuntos,
    SoporteAdjuntos,
    MetricasReadModel,
    ChatMetricsService,
    PlatformChatMetricsService,
  ],
  // El asistente con IA (`assistant-ai`) escribe y avisa por los mismos caminos.
  exports: [
    MessageWriter,
    ChatEvents,
    ChatViewsService,
    CompanyChatSettingsService,
    SupportSettingsService,
    RespuestasFijas,
    AsistenteDelChat,
  ],
})
export class ChatModule {}
