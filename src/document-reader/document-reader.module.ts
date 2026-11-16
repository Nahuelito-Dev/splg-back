import Anthropic from '@anthropic-ai/sdk';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CLIENTE_ANTHROPIC,
  CONFIGURACION_DEL_LECTOR,
  ClaudeDocumentReader,
  ConfiguracionDelLector,
} from './claude-document-reader';
import { DocumentReaderPort } from './document-reader.port';
import { LectorDeDocumentosNulo } from './lector-de-documentos-nulo';

/** Modelo por omisión del lector; `LECTOR_MODELO` lo cambia sin tocar el código. */
export const MODELO_DEL_LECTOR = 'claude-opus-5-5';

/**
 * Lector de documentos del módulo M6. Con `ANTHROPIC_API_KEY` lee con Claude;
 * sin ella, el lector nulo y los datos se cargan a mano.
 */
@Global()
@Module({
  providers: [
    {
      provide: CLIENTE_ANTHROPIC,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Anthropic | null => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        return apiKey
          ? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 })
          : null;
      },
    },
    {
      provide: CONFIGURACION_DEL_LECTOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ConfiguracionDelLector => ({
        modelo: config.get<string>('LECTOR_MODELO') || MODELO_DEL_LECTOR,
        esfuerzo:
          (config.get<string>(
            'LECTOR_ESFUERZO',
          ) as ConfiguracionDelLector['esfuerzo']) || 'medium',
      }),
    },
    {
      provide: DocumentReaderPort,
      inject: [CLIENTE_ANTHROPIC, CONFIGURACION_DEL_LECTOR],
      useFactory: (
        cliente: Anthropic | null,
        configuracion: ConfiguracionDelLector,
      ): DocumentReaderPort =>
        cliente
          ? new ClaudeDocumentReader(cliente, configuracion)
          : new LectorDeDocumentosNulo(),
    },
  ],
  // El cliente también lo usa el asistente con IA (B3), con su propio timeout por consulta.
  exports: [DocumentReaderPort, CLIENTE_ANTHROPIC],
})
export class DocumentReaderModule {}
