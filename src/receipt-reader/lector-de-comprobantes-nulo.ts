import { Injectable } from '@nestjs/common';

import { ReceiptReaderPort } from './receipt-reader.port';

/** Sin lector configurado: el admin carga los datos del comprobante a mano. */
@Injectable()
export class LectorDeComprobantesNulo extends ReceiptReaderPort {
  readonly disponible = false;

  leer(): Promise<null> {
    return Promise.resolve(null);
  }
}
