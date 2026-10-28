import { Global, Module } from '@nestjs/common';

import { LectorDeComprobantesNulo } from './lector-de-comprobantes-nulo';
import { ReceiptReaderPort } from './receipt-reader.port';

@Global()
@Module({
  providers: [
    { provide: ReceiptReaderPort, useClass: LectorDeComprobantesNulo },
  ],
  exports: [ReceiptReaderPort],
})
export class ReceiptReaderModule {}
