import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssistantFaqTemplateService } from './assistant-faq-template.service';
import { AssistantFaqService } from './assistant-faq.service';
import { CompanyAssistantFaqController } from './company-assistant-faq.controller';
import { CompanyAssistantTemplateController } from './company-assistant-template.controller';
import { AssistantFaqTemplate } from './entities/assistant-faq-template.entity';
import { AssistantFaq } from './entities/assistant-faq.entity';
import { AssistantKnowledgeBase } from './entities/assistant-knowledge-base.entity';
import { PlatformAssistantFaqController } from './platform-assistant-faq.controller';
import { PlatformAssistantTemplateController } from './platform-assistant-template.controller';

/**
 * Asistente del chat (módulo M8, DISENO-CH-BOT). Etapa B2: la base de
 * conocimiento de cada distribuidora, la de la plataforma y el catálogo de
 * preguntas de ejemplo que copian las distribuidoras (D-B7). Exporta el
 * servicio para que la capa inteligente (B3) lea la base como contexto.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssistantKnowledgeBase,
      AssistantFaq,
      AssistantFaqTemplate,
    ]),
  ],
  controllers: [
    CompanyAssistantFaqController,
    CompanyAssistantTemplateController,
    PlatformAssistantFaqController,
    PlatformAssistantTemplateController,
  ],
  providers: [AssistantFaqService, AssistantFaqTemplateService],
  exports: [AssistantFaqService],
})
export class AssistantModule {}
