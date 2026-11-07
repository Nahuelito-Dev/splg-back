import { Injectable } from '@nestjs/common';

import {
  CampoLeido,
  DocumentReaderPort,
  esLecturaFallida,
  NivelDeConfianza,
  AVISO_DE_NEGATIVA,
} from '../document-reader/document-reader.port';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import { DocumentReadingService } from '../document-reading/document-reading.service';
import {
  ArchivoDeComprobante,
  DatosDelComprobante,
  OrigenDelComprobante,
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
  constructor(
    private readonly documentos: DocumentReaderPort,
    private readonly lecturas?: DocumentReadingService,
  ) {
    super();
  }

  get disponible(): boolean {
    return this.documentos.disponible;
  }

  async leer(
    archivo: ArchivoDeComprobante,
    pistas?: PistasDelComprobante,
    origen?: OrigenDelComprobante,
  ): Promise<DatosDelComprobante | null> {
    const esperado: Record<string, string> = {};
    if (pistas?.expectedAmount) esperado['importe'] = pistas.expectedAmount;
    if (pistas?.payee) esperado['destinatario'] = pistas.payee;
    const opciones = {
      tipoEsperado: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      pistas: esperado,
    };
    // Con el adjunto, la lectura queda guardada (módulo M6) y no se vuelve a pagar.
    let lectura;
    if (origen && this.lecturas) {
      const resultado = await this.lecturas.leerAdjunto({
        ...origen,
        archivo,
        opciones,
      });
      // La concilia el barrido periódico, con margen para que el admin termine el pago.
      lectura = resultado.lectura;
    } else lectura = await this.documentos.leer(archivo, opciones);
    if (
      !lectura ||
      esLecturaFallida(lectura) ||
      // Sólo la negativa del servicio va a carga manual; un ilegible común trae sus avisos.
      (!lectura.legible && lectura.avisos.includes(AVISO_DE_NEGATIVA))
    )
      return null;
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
