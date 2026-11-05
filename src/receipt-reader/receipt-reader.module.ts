import { Global, Module } from '@nestjs/common';

import { DocumentReaderPort } from '../document-reader/document-reader.port';
import { LectorDeComprobantesSobreDocumentos } from './lector-de-comprobantes-sobre-documentos';
import { ReceiptReaderPort } from './receipt-reader.port';

/**
 * El escaneo de comprobantes de multas y cuotas de seguro: usa el lector de
 * documentos del módulo M6 (`DocumentReaderModule`, global).
 */
@Global()
@Module({
  providers: [
    {
      provide: ReceiptReaderPort,
      inject: [DocumentReaderPort],
      useFactory: (documentos: DocumentReaderPort) =>
        new LectorDeComprobantesSobreDocumentos(documentos),
    },
  ],
  exports: [ReceiptReaderPort],
})
export class ReceiptReaderModule {}
