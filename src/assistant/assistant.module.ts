import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssistantFaqService } from './assistant-faq.service';
import { CompanyAssistantFaqController } from './company-assistant-faq.controller';
import { AssistantFaq } from './entities/assistant-faq.entity';
import { AssistantKnowledgeBase } from './entities/assistant-knowledge-base.entity';
import { PlatformAssistantFaqController } from './platform-assistant-faq.controller';

/**
 * Asistente del chat (módulo M8, DISENO-CH-BOT). Etapa B2: la base de
 * conocimiento de cada distribuidora y la de la plataforma. Exporta el
 * servicio para que la capa inteligente (B3) lea la base como contexto.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AssistantKnowledgeBase, AssistantFaq])],
  controllers: [CompanyAssistantFaqController, PlatformAssistantFaqController],
  providers: [AssistantFaqService],
  exports: [AssistantFaqService],
})
export class AssistantModule {}
