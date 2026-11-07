import {
  DocumentReaderPort,
  LecturaDeDocumento,
} from '../document-reader/document-reader.port';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import { LectorDeComprobantesSobreDocumentos } from './lector-de-comprobantes-sobre-documentos';

const uso = {
  modelo: 'claude-opus-5-5',
  tokensDeEntrada: 1,
  tokensDeSalida: 1,
  costoUsd: 0,
};

function armar(lectura: LecturaDeDocumento | null, disponible = true) {
  const leer = jest.fn().mockResolvedValue(lectura);
  const documentos = { disponible, leer } as unknown as DocumentReaderPort;
  return { lector: new LectorDeComprobantesSobreDocumentos(documentos), leer };
}

const archivo = { buffer: Buffer.from('x'), mimeType: 'application/pdf' };

describe('LectorDeComprobantesSobreDocumentos', () => {
  it('traduce la lectura del comprobante de pago al formato del formulario', async () => {
    const { lector, leer } = armar({
      tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      legible: true,
      campos: [
        { nombre: 'importe', valor: '38390.00', confianza: 'alta' },
        {
          nombre: 'fecha_de_pago',
          valor: '2026-11-03T10:00:00-03:00',
          confianza: 'alta',
        },
        { nombre: 'numero_de_operacion', valor: '123', confianza: 'media' },
        { nombre: 'destinatario', valor: 'La Segunda', confianza: 'alta' },
        {
          nombre: 'cuit_del_destinatario',
          valor: '30500036911',
          confianza: 'alta',
        },
        { nombre: 'periodo', valor: '2026-11', confianza: 'alta' },
      ],
      avisos: ['un aviso'],
      uso,
    });
    await expect(
      lector.leer(archivo, { expectedAmount: '38390.00', payee: 'La Segunda' }),
    ).resolves.toEqual({
      amount: '38390.00',
      paidAt: '2026-11-03T10:00:00-03:00',
      operationNumber: '123',
      payee: 'La Segunda',
      payeeTaxId: '30500036911',
      period: '2026-11',
      confidence: 'medium',
      warnings: ['un aviso'],
    });
    expect(leer).toHaveBeenCalledWith(archivo, {
      tipoEsperado: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      pistas: { importe: '38390.00', destinatario: 'La Segunda' },
    });
  });

  it('si no es un comprobante de pago, confianza baja y lo avisa primero', async () => {
    const { lector } = armar({
      tipo: TipoDeDocumento.POLIZA,
      legible: true,
      campos: [],
      avisos: ['otro aviso'],
      uso,
    });
    const datos = await lector.leer(archivo);
    expect(datos?.confidence).toBe('low');
    expect(datos?.warnings).toEqual([
      'El documento no parece un comprobante de pago',
      'otro aviso',
    ]);
    expect(datos?.amount).toBeNull();
  });

  it('ilegible o sin datos: confianza baja', async () => {
    const ilegible = armar({
      tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      legible: false,
      campos: [],
      avisos: [],
      uso,
    });
    await expect(ilegible.lector.leer(archivo)).resolves.toMatchObject({
      confidence: 'low',
    });
    const vacio = armar({
      tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      legible: true,
      campos: [],
      avisos: [],
      uso,
    });
    await expect(vacio.lector.leer(archivo)).resolves.toMatchObject({
      confidence: 'low',
    });
  });

  it('una negativa del servicio deja que el formulario cargue los datos a mano', async () => {
    const negativa = armar({
      tipo: TipoDeDocumento.OTRO,
      legible: false,
      campos: [],
      avisos: ['El servicio de lectura no quiso procesar este documento'],
      uso,
    });
    await expect(negativa.lector.leer(archivo)).resolves.toBeNull();
  });

  it('refleja si el lector de documentos está disponible y devuelve null si no leyó', async () => {
    const { lector } = armar(null, false);
    expect(lector.disponible).toBe(false);
    await expect(lector.leer(archivo)).resolves.toBeNull();
  });
});
