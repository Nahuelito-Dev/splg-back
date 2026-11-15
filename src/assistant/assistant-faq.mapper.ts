import type {
  AssistantFaqListResponseDto,
  AssistantFaqResponseDto,
  PlatformAssistantFaqListResponseDto,
  PlatformAssistantFaqResponseDto,
} from './dto/assistant-faq.dto';
import type { BaseDeConocimiento } from './assistant-faq.service';
import { TOPE_DE_PREGUNTAS } from './assistant.errors';
import type { AssistantFaq } from './entities/assistant-faq.entity';

/** De la entidad a la respuesta: sin ids de base, autores ni fechas de baja. */
export const AssistantFaqMapper = {
  toDto(fila: AssistantFaq): AssistantFaqResponseDto {
    return {
      id: fila.faqId,
      key: fila.key,
      question: fila.question,
      answer: fila.answer,
      position: fila.position,
      createdAt: fila.createdAt.toISOString(),
      updatedAt: fila.updatedAt.toISOString(),
    };
  },

  toPlatformDto(fila: AssistantFaq): PlatformAssistantFaqResponseDto {
    return {
      id: fila.faqId,
      // En la plataforma la clave es obligatoria (CHK_assistant_faq_clave_de_plataforma).
      key: fila.key ?? '',
      question: fila.question,
      answer: fila.answer,
      position: fila.position,
      useAsTemplate: fila.useAsTemplate,
      createdAt: fila.createdAt.toISOString(),
      updatedAt: fila.updatedAt.toISOString(),
    };
  },

  toListDto(base: BaseDeConocimiento): AssistantFaqListResponseDto {
    return {
      items: base.items.map((f) => AssistantFaqMapper.toDto(f)),
      version: base.version,
      limit: TOPE_DE_PREGUNTAS,
    };
  },

  toPlatformListDto(
    base: BaseDeConocimiento,
  ): PlatformAssistantFaqListResponseDto {
    return {
      items: base.items.map((f) => AssistantFaqMapper.toPlatformDto(f)),
      version: base.version,
      limit: TOPE_DE_PREGUNTAS,
    };
  },
};
