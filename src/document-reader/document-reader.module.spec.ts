import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ReceiptReaderModule } from '../receipt-reader/receipt-reader.module';
import { ReceiptReaderPort } from '../receipt-reader/receipt-reader.port';
import { ClaudeDocumentReader } from './claude-document-reader';
import { DocumentReaderModule } from './document-reader.module';
import { DocumentReaderPort } from './document-reader.port';
import { LectorDeDocumentosNulo } from './lector-de-documentos-nulo';

async function armar(env: Record<string, string>) {
  const modulo = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => env],
      }),
      DocumentReaderModule,
      ReceiptReaderModule,
    ],
  }).compile();
  return {
    documentos: modulo.get(DocumentReaderPort),
    comprobantes: modulo.get(ReceiptReaderPort),
  };
}

describe('DocumentReaderModule', () => {
  it('con ANTHROPIC_API_KEY lee con Claude, y el escaneo de comprobantes queda disponible', async () => {
    const { documentos, comprobantes } = await armar({
      ANTHROPIC_API_KEY: 'sk-ant-api03-de-prueba',
    });
    expect(documentos).toBeInstanceOf(ClaudeDocumentReader);
    expect(documentos.disponible).toBe(true);
    expect(comprobantes.disponible).toBe(true);
  });

  it('sin la clave usa el lector nulo: nada se lee y se carga a mano', async () => {
    const { documentos, comprobantes } = await armar({});
    expect(documentos).toBeInstanceOf(LectorDeDocumentosNulo);
    expect(comprobantes.disponible).toBe(false);
    await expect(
      documentos.leer({
        buffer: Buffer.from('x'),
        mimeType: 'application/pdf',
      }),
    ).resolves.toBeNull();
  });
});
