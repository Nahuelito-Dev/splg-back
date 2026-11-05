import { Injectable } from '@nestjs/common';

import {
  CampoLeido,
  DocumentReaderPort,
  NivelDeConfianza,
} from '../document-reader/document-reader.port';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import {
  ArchivoDeComprobante,
  DatosDelComprobante,
  PistasDelComprobante,
  ReceiptReaderPort,
} from './receipt-reader.port';

const CONFIANZA: Record<NivelDeConfianza, DatosDelComprobante['confidence']> = {
  alta: 'high',
  media: 'medium',
  baja: 'low',
};
const ORDEN: NivelDeConfianza[] = ['baja', 'media', 'alta'];

/**
 * El escaneo de comprobantes (multas y cuotas de seguro) sobre el lector de
 * documentos del módulo M6: lo lee como comprobante de pago y lo traduce al
 * formato que ya usan esos formularios.
 */
@Injectable()
export class LectorDeComprobantesSobreDocumentos extends ReceiptReaderPort {
  constructor(private readonly documentos: DocumentReaderPort) {
    super();
  }

  get disponible(): boolean {
    return this.documentos.disponible;
  }

  async leer(
    archivo: ArchivoDeComprobante,
    pistas?: PistasDelComprobante,
  ): Promise<DatosDelComprobante | null> {
    const esperado: Record<string, string> = {};
    if (pistas?.expectedAmount) esperado['importe'] = pistas.expectedAmount;
    if (pistas?.payee) esperado['destinatario'] = pistas.payee;
    const lectura = await this.documentos.leer(archivo, {
      tipoEsperado: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      pistas: esperado,
    });
    if (!lectura) return null;
    const valor = (nombre: string) =>
      lectura.campos.find((c) => c.nombre === nombre)?.valor ?? null;
    const avisos = [...lectura.avisos];
    if (lectura.tipo !== TipoDeDocumento.COMPROBANTE_DE_PAGO) {
      avisos.unshift('El documento no parece un comprobante de pago');
    }
    return {
      amount: valor('importe'),
      paidAt: valor('fecha_de_pago'),
      operationNumber: valor('numero_de_operacion'),
      payee: valor('destinatario'),
      payeeTaxId: valor('cuit_del_destinatario'),
      period: valor('periodo'),
      confidence:
        lectura.legible && lectura.tipo === TipoDeDocumento.COMPROBANTE_DE_PAGO
          ? CONFIANZA[confianzaMinima(lectura.campos)]
          : 'low',
      warnings: avisos,
    };
  }
}

/** La confianza del comprobante es la del dato menos seguro que se leyó. */
function confianzaMinima(campos: CampoLeido[]): NivelDeConfianza {
  const conValor = campos.filter((c) => c.valor !== null);
  if (!conValor.length) return 'baja';
  return conValor.reduce<NivelDeConfianza>(
    (min, c) =>
      ORDEN.indexOf(c.confianza) < ORDEN.indexOf(min) ? c.confianza : min,
    'alta',
  );
}
