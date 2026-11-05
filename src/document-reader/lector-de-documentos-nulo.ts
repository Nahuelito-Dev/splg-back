import { Injectable } from '@nestjs/common';

import { DocumentReaderPort } from './document-reader.port';

/** Sin lector configurado: los datos del documento se cargan a mano. */
@Injectable()
export class LectorDeDocumentosNulo extends DocumentReaderPort {
  readonly disponible = false;

  leer(): Promise<null> {
    return Promise.resolve(null);
  }
}
