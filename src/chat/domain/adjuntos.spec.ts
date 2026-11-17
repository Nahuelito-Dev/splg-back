import { AttachmentScanStatus } from '../../attachment/attachment-scan-status';
import {
  CSV_MIME_TYPE,
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from '../../common/utils/attachment-rules';
import {
  CANAL_CHOFER_CLIENTE,
  escaneoInicial,
  estadoTrasEscanear,
  lecturaDelAdjunto,
  medioDelMensaje,
  reglaDeAdjuntos,
  topeDe,
  TOPE_DE_ARCHIVO_DEL_CHAT,
  TOPE_DE_FOTO_DEL_CHAT,
  vistaPreviaDelAdjunto,
} from './adjuntos';
import { Channel, MessageKind, MessageVisibility } from './chat.enums';
import { vistaPreviaDelMensaje } from './reglas-del-mensaje';

const MB = 1024 * 1024;

describe('adjuntos del chat: tipos y topes por canal (§9.2)', () => {
  it('C1 (chat y ticket): PDF, fotos, Word, Excel y CSV, todo hasta 10 MB', () => {
    for (const canal of [Channel.PLATFORM_CHAT, Channel.PLATFORM_TICKET]) {
      const r = reglaDeAdjuntos(canal);
      expect(r.tipos).toEqual(
        expect.arrayContaining([
          'application/pdf',
          'image/jpeg',
          'image/png',
          'image/webp',
          DOCX_MIME_TYPE,
          XLSX_MIME_TYPE,
          CSV_MIME_TYPE,
        ]),
      );
      expect(topeDe(r, 'image/jpeg')).toBe(10 * MB);
      expect(topeDe(r, 'application/pdf')).toBe(10 * MB);
    }
  });

  it('C2 y C3: fotos de 5 MB y PDF de 10 MB, sin Office', () => {
    for (const canal of [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER]) {
      const r = reglaDeAdjuntos(canal);
      expect([...r.tipos].sort()).toEqual(
        ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].sort(),
      );
      expect(topeDe(r, 'image/png')).toBe(TOPE_DE_FOTO_DEL_CHAT);
      expect(topeDe(r, 'application/pdf')).toBe(TOPE_DE_ARCHIVO_DEL_CHAT);
      expect(r.tipos).not.toContain(DOCX_MIME_TYPE);
    }
  });

  it('C4 (chofer ↔ cliente): sólo fotos de 5 MB; un PDF no entra (D-C13)', () => {
    const r = reglaDeAdjuntos(CANAL_CHOFER_CLIENTE);
    expect(r.tipos).not.toContain('application/pdf');
    expect([...r.tipos].sort()).toEqual(
      ['image/jpeg', 'image/png', 'image/webp'].sort(),
    );
    expect(topeDe(r, 'image/webp')).toBe(5 * MB);
    expect(r.tiposEnTexto).toBe('fotos JPG, PNG o WEBP');
  });
});

describe('escaneo y lectura (§9.3, §9.4)', () => {
  it('una foto nace limpia (la re-codifica sharp); PDF y Office, pendientes', () => {
    expect(escaneoInicial('image/jpeg')).toBe(AttachmentScanStatus.CLEAN);
    expect(escaneoInicial('application/pdf')).toBe(
      AttachmentScanStatus.PENDING,
    );
    expect(escaneoInicial(XLSX_MIME_TYPE)).toBe(AttachmentScanStatus.PENDING);
  });

  it('pendiente → 409; infectado → oculto; fallido → 409 para todos (también el personal)', () => {
    expect(lecturaDelAdjunto(AttachmentScanStatus.PENDING)).toBe('pendiente');
    expect(lecturaDelAdjunto(AttachmentScanStatus.INFECTED)).toBe('bloqueado');
    expect(lecturaDelAdjunto(AttachmentScanStatus.FAILED)).toBe('fallido');
    expect(lecturaDelAdjunto(AttachmentScanStatus.CLEAN)).toBe('firmar');
  });

  it('el resultado sólo cambia lo pendiente o fallido: infectado gana sobre fallido, nada pisa limpio ni infectado', () => {
    const { PENDING, FAILED, CLEAN, INFECTED } = AttachmentScanStatus;
    expect(estadoTrasEscanear(PENDING, CLEAN)).toBe(CLEAN);
    expect(estadoTrasEscanear(FAILED, INFECTED)).toBe(INFECTED);
    expect(estadoTrasEscanear(FAILED, FAILED)).toBe(FAILED);
    expect(estadoTrasEscanear(CLEAN, INFECTED)).toBeNull();
    expect(estadoTrasEscanear(INFECTED, FAILED)).toBeNull();
  });
});

describe('vista previa de un adjunto', () => {
  it('«📎 Foto» o «📎 Archivo», sin el epígrafe', () => {
    expect(vistaPreviaDelAdjunto('photo')).toBe('📎 Foto');
    expect(vistaPreviaDelAdjunto('file')).toBe('📎 Archivo');
    expect(
      vistaPreviaDelMensaje({
        kind: MessageKind.ATTACHMENT,
        body: 'mi comprobante',
        visibility: MessageVisibility.ALL,
        payload: { media: 'file' },
      }),
    ).toBe('📎 Archivo');
    expect(
      vistaPreviaDelMensaje({
        kind: MessageKind.ATTACHMENT,
        body: null,
        visibility: MessageVisibility.ALL,
        payload: { media: 'photo' },
      }),
    ).toBe('📎 Foto');
  });

  it('un texto sigue con su vista previa; un adjunto redactado (sin medio) dice archivo', () => {
    expect(
      vistaPreviaDelMensaje({
        kind: MessageKind.TEXT,
        body: '  hola   che ',
        visibility: MessageVisibility.ALL,
        payload: null,
      }),
    ).toBe('hola che');
    expect(
      medioDelMensaje({ kind: MessageKind.ATTACHMENT, payload: null }),
    ).toBe('file');
    expect(medioDelMensaje({ kind: MessageKind.TEXT, payload: null })).toBe(
      null,
    );
  });
});
