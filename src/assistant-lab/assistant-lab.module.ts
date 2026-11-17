import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AsistenteIaModule } from '../assistant-ai/asistente-ia.module';
import { AssistantModule } from '../assistant/assistant.module';
import { CompanyAssistantLabController } from './company-assistant-lab.controller';
import { AssistantRegressionCase } from './entities/assistant-regression-case.entity';
import { AssistantRegressionRun } from './entities/assistant-regression-run.entity';
import { AssistantUnansweredResolution } from './entities/assistant-unanswered-resolution.entity';
import { PlatformAssistantLabController } from './platform-assistant-lab.controller';
import { PreguntasSinRespuestaService } from './preguntas-sin-respuesta.service';
import { ProbadorService } from './probador.service';
import { RegresionService } from './regresion.service';

/**
 * Herramientas para afinar el asistente del chat (DISENO-CH-BOT §7, tanda
 * 7b): el probador (contesta una pregunta suelta por el mismo camino que una
 * conversación real, sin publicar nada), las preguntas que no supo contestar
 * (agrupadas, para sumarlas a la base) y el lote de regresión de cada
 * empresa. Para la empresa (módulo M8) y para el soporte de la plataforma.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssistantRegressionCase,
      AssistantRegressionRun,
      AssistantUnansweredResolution,
    ]),
    AsistenteIaModule,
    AssistantModule,
  ],
  controllers: [CompanyAssistantLabController, PlatformAssistantLabController],
  providers: [ProbadorService, PreguntasSinRespuestaService, RegresionService],
})
export class AssistantLabModule {}
