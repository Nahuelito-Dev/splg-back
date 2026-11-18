import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssistantModule } from '../assistant/assistant.module';
import { ChatModule } from '../chat/chat.module';
import { GasCylinderModule } from '../gascylinder/gascylinder.module';
import { SeguimientoDelClienteModule } from '../route-batch/seguimiento-del-cliente/seguimiento-del-cliente.module';
import { AsistenteIaRescateCron } from './asistente-ia-rescate.cron';
import { AsistenteIaListener } from './asistente-ia.listener';
import { AsistenteIaService } from './asistente-ia.service';
import { ConsultaAlAsistente } from './consulta-al-modelo';
import { AssistantTestUsage } from './entities/assistant-test-usage.entity';
import { AssistantTrace } from './entities/assistant-trace.entity';
import { HerramientasDelAsistente } from './herramientas';

/**
 * Asistente del chat con IA (módulo M8, DISENO-CH-BOT §4, etapa B3): contesta
 * en C3 (clientes de cada empresa, con su base y lectura de sus propios
 * pedidos) y en C1 (soporte de la plataforma, con la base de OrixTech) con
 * Claude Haiku 5.5, o pasa la conversación a una persona. Usa el cliente de
 * Anthropic del lector de documentos (`CLIENTE_ANTHROPIC`, global): sin
 * `ANTHROPIC_API_KEY`, deriva sin consultar. Exporta el servicio para el
 * probador y el lote de regresión (`assistant-lab`), que contestan por el
 * mismo camino.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AssistantTrace, AssistantTestUsage]),
    ChatModule,
    AssistantModule,
    GasCylinderModule,
    SeguimientoDelClienteModule, // el reparto de los pedidos del cliente (hoja de ruta)
  ],
  providers: [
    AsistenteIaService,
    AsistenteIaListener,
    AsistenteIaRescateCron,
    ConsultaAlAsistente,
    HerramientasDelAsistente,
  ],
  exports: [AsistenteIaService],
})
export class AsistenteIaModule {}
