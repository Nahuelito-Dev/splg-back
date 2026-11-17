import { HttpException } from '@nestjs/common';
import sharp from 'sharp';
import type { DataSource, EntityManager } from 'typeorm';
import { AttachmentScanStatus } from '../../attachment/attachment-scan-status';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../attachment/entities/attachment.entity';
import { imagenesDePrueba, tieneExif } from '../../s3/imagenes-de-prueba';
import * as limpieza from '../../s3/limpiar-imagen';
import { zipDePrueba as zipDe } from '../../common/utils/zip-de-prueba';
import type { S3CleanupService } from '../../s3/s3-cleanup.service';
import type { S3Service } from '../../s3/s3.service';
import { CANAL_CHOFER_CLIENTE } from '../domain/adjuntos';
import {
  Channel,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
} from '../domain/chat.enums';
import {
  AdjuntoEnEscaneoError,
  AdjuntoNoEncontradoError,
  AdjuntoSinVerificarError,
  ConversacionCerradaError,
} from '../domain/chat.errors';
import type { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import {
  AdjuntosDelChat,
  nombreConSuExtension,
  type EscribirElMensaje,
} from './adjuntos-del-chat.service';
import type { ChatEvents, Efectos } from './chat.events';
import type { ChatRateLimit } from './chat-rate-limit';
import type { EscaneoDeAdjuntos } from './escaneo-de-adjuntos';
import type { NuevoMensaje } from './mensajes.port';

const D = 'dist-a';
const CONV = 'conv-1';
const CMID = '0d6f0c34-8b7e-4c1a-9f3b-5a2e7d9c1b20';
const PDF = Buffer.from('%PDF-1.4\n%prueba\n');
const MB = 1024 * 1024;

function conversacion(extra: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: CONV,
    distributorId: D,
    channel: Channel.STAFF_CUSTOMER,
    status: ConversationStatus.OPEN,
    ...extra,
  } as Conversation;
}

function archivo(
  buffer: Buffer,
  originalname = 'archivo',
  mimetype = 'application/octet-stream',
): Express.Multer.File {
  return {
    buffer,
    originalname,
    mimetype,
    size: buffer.length,
  } as Express.Multer.File;
}

/** Coincide si todas las claves de `where` son iguales en la fila. */
const coincide = (fila: object, where: object): boolean =>
  Object.entries(where).every(
    ([k, v]) => (fila as Record<string, unknown>)[k] === v,
  );

function armar(opciones: { hoy?: number; falla?: boolean } = {}) {
  const mensajes: Message[] = [];
  const adjuntos: Attachment[] = [];
  const repoMensajes = {
    findOne: jest.fn(({ where }: { where: object }) =>
      Promise.resolve(mensajes.find((m) => coincide(m, where)) ?? null),
    ),
  };
  const repoAdjuntos = {
    findOne: jest.fn(({ where }: { where: object }) =>
      Promise.resolve(adjuntos.find((a) => coincide(a, where)) ?? null),
    ),
    create: (x: Partial<Attachment>) =>
      ({ attachmentId: 'adj-1', ...x }) as Attachment,
    save: jest.fn((a: Attachment) => {
      if (opciones.falla) return Promise.reject(new Error('se cayó la base'));
      adjuntos.push(a);
      return Promise.resolve(a);
    }),
  };
  const query = jest.fn((sql: string) =>
    Promise.resolve(
      sql.includes('count(*)') ? [{ n: String(opciones.hoy ?? 0) }] : [],
    ),
  );
  const manager = {
    getRepository: (e: unknown) =>
      e === Message ? repoMensajes : repoAdjuntos,
    query,
  };
  const dataSource = {
    manager,
    getRepository: manager.getRepository,
    transaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) =>
      fn(manager as unknown as EntityManager),
    ),
  };
  const storage = {
    put: jest.fn().mockResolvedValue(undefined),
    getSignedDownload: jest.fn().mockResolvedValue({
      url: 'https://s3/firmada',
      expiresAt: new Date('2026-11-16T12:05:00Z'),
    }),
  };
  const orden: string[] = [];
  const cleanup = {
    reserveUpload: jest.fn((k: string) => {
      orden.push(`reservar ${k}`);
      return Promise.resolve();
    }),
    confirmUpload: jest.fn((_m: unknown, k: string) => {
      orden.push(`confirmar ${k}`);
      return Promise.resolve();
    }),
    removeInBackground: jest.fn(),
  };
  storage.put.mockImplementation(({ key }: { key: string }) => {
    orden.push(`subir ${key}`);
    return Promise.resolve();
  });
  const cupos = { mensaje: jest.fn().mockResolvedValue(undefined) };
  const eventos = { publicar: jest.fn() };
  const escaneo = { encolar: jest.fn() };
  const servicio = new AdjuntosDelChat(
    dataSource as unknown as DataSource,
    storage as unknown as S3Service,
    cleanup as unknown as S3CleanupService,
    cupos as unknown as ChatRateLimit,
    eventos as unknown as ChatEvents,
    escaneo as unknown as EscaneoDeAdjuntos,
  );
  const escritos: NuevoMensaje[] = [];
  const escribir = jest.fn(
    (_m: EntityManager, nuevo: NuevoMensaje, efectos: Efectos) => {
      escritos.push(nuevo);
      const message = {
        messageId: 'msg-1',
        seq: 3,
        createdAt: new Date(),
        redactedAt: null,
        withdrawnAt: null,
        ...nuevo,
      } as unknown as Message;
      mensajes.push(message);
      efectos.mensaje(conversacion(), message);
      return Promise.resolve({
        message,
        created: true,
        conversation: conversacion(),
      });
    },
  );
  return {
    servicio,
    mensajes,
    adjuntos,
    storage,
    cleanup,
    cupos,
    eventos,
    escaneo,
    escribir,
    escritos,
    orden,
    query,
  };
}

const subir = (
  t: ReturnType<typeof armar>,
  f: Express.Multer.File | undefined,
  c: Conversation = conversacion(),
  escribir: EscribirElMensaje = t.escribir,
  caption?: string,
) =>
  t.servicio.subir(
    {
      conversation: c,
      party: Party.CUSTOMER,
      userId: 'cli-1',
      archivo: f,
      dto: { clientMessageId: CMID, caption },
      cupo: { ambito: D, conversacion: c.conversationId },
    },
    escribir,
  );

async function rechazo(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (e) {
    return {
      status: (e as HttpException).getStatus(),
      ...((e as HttpException).getResponse() as object),
    };
  }
  throw new Error('no rechazó');
}

describe('AdjuntosDelChat: subir', () => {
  it('una foto con EXIF se guarda re-codificada y sin EXIF, limpia, con sus medidas y la key de la empresa', async () => {
    const t = armar();
    const foto = await imagenesDePrueba.jpeg(true);
    expect(await tieneExif(foto)).toBe(true);
    const r = await subir(t, archivo(foto, 'casa.jpg', 'image/jpeg'));

    expect(r.created).toBe(true);
    const subido = (t.storage.put.mock.calls[0] as unknown[])[0] as {
      key: string;
      body: Buffer;
      contentType: string;
    };
    expect(await tieneExif(subido.body)).toBe(false);
    expect(subido.contentType).toBe('image/jpeg');
    expect(subido.key).toMatch(
      new RegExp(`^d/${D}/chat/${CONV}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(r.attachment).toMatchObject({
      ownerType: AttachmentOwnerType.CHAT_MESSAGE,
      ownerId: 'msg-1',
      messageId: 'msg-1',
      distributorId: D,
      storageKey: subido.key,
      mimeType: 'image/jpeg',
      sizeBytes: subido.body.length,
      scanStatus: AttachmentScanStatus.CLEAN,
      width: 40,
      height: 20,
      uploadedByUserId: 'cli-1',
    });
    // Reserva antes de subir; confirma en la transacción que guarda la referencia.
    expect(t.orden).toEqual([
      `reservar ${subido.key}`,
      `subir ${subido.key}`,
      `confirmar ${subido.key}`,
    ]);
    expect(t.escritos[0]).toMatchObject({
      kind: MessageKind.ATTACHMENT,
      visibility: MessageVisibility.ALL,
      body: null,
      payload: { media: 'photo' },
      clientMessageId: CMID,
      senderParty: Party.CUSTOMER,
    });
    expect(t.escaneo.encolar).not.toHaveBeenCalled();
    expect(t.eventos.publicar).toHaveBeenCalledTimes(1);
    expect(t.cleanup.removeInBackground).not.toHaveBeenCalled();
  });

  it('un PDF queda pendiente y se manda al antivirus después del commit, con su epígrafe', async () => {
    const t = armar();
    const r = await subir(
      t,
      archivo(PDF, 'remito.pdf', 'application/pdf'),
      conversacion(),
      t.escribir,
      'El remito de hoy',
    );
    expect(r.attachment?.scanStatus).toBe(AttachmentScanStatus.PENDING);
    expect(r.attachment?.width).toBeNull();
    expect(t.escritos[0]).toMatchObject({
      body: 'El remito de hoy',
      payload: { media: 'file' },
    });
    expect(t.escaneo.encolar).toHaveBeenCalledWith('adj-1');
  });

  it('el tipo sale del contenido: una foto con nombre y tipo de PDF se guarda como foto', async () => {
    const t = armar();
    const png = await imagenesDePrueba.png();
    const r = await subir(t, archivo(png, 'remito.pdf', 'application/pdf'));
    expect(r.attachment?.mimeType).toBe('image/png');
    expect(r.attachment?.originalName).toBe('remito.pdf.png');
  });

  it('un PDF en C4 (chofer ↔ cliente) es 415 y no sube nada', async () => {
    const t = armar();
    const e = await rechazo(
      subir(
        t,
        archivo(PDF, 'a.pdf', 'application/pdf'),
        conversacion({
          channel: CANAL_CHOFER_CLIENTE as unknown as Channel,
        }),
      ),
    );
    expect(e).toMatchObject({
      status: 415,
      code: 'ATTACHMENT_TYPE_NOT_ALLOWED',
    });
    expect(e.message).toBe(
      'En este chat se pueden mandar fotos JPG, PNG o WEBP.',
    );
    expect(t.storage.put).not.toHaveBeenCalled();
    expect(t.cleanup.reserveUpload).not.toHaveBeenCalled();
  });

  it('un Excel en la bandeja es 415; en el soporte (C1) entra', async () => {
    const t = armar();
    const xlsx = Buffer.from(
      // ZIP mínimo con [Content_Types].xml y xl/workbook.xml (sin comprimir).
      zipDe(['[Content_Types].xml', 'xl/workbook.xml']),
    );
    expect(await rechazo(subir(t, archivo(xlsx, 'a.xlsx')))).toMatchObject({
      status: 415,
    });
    const r = await subir(
      t,
      archivo(xlsx, 'a.xlsx'),
      conversacion({ channel: Channel.PLATFORM_CHAT }),
    );
    expect(r.attachment?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('un ejecutable con nombre de PDF es 415', async () => {
    const t = armar();
    expect(
      await rechazo(
        subir(
          t,
          archivo(Buffer.from('MZ\x90\x00'), 'f.pdf', 'application/pdf'),
        ),
      ),
    ).toMatchObject({ status: 415, code: 'ATTACHMENT_TYPE_NOT_ALLOWED' });
  });

  it('una imagen que no decodifica es 415 (`ATTACHMENT_UNREADABLE`) y no sube nada', async () => {
    const t = armar();
    const rota = Buffer.concat([
      (await imagenesDePrueba.jpeg()).subarray(0, 30),
      Buffer.alloc(30),
    ]);
    expect(
      await rechazo(subir(t, archivo(rota, 'x.jpg', 'image/jpeg'))),
    ).toMatchObject({ status: 415, code: 'ATTACHMENT_UNREADABLE' });
    expect(t.storage.put).not.toHaveBeenCalled();
  });

  it('una foto de más de 5 MB en la bandeja es 413; un PDF de 6 MB entra', async () => {
    const t = armar();
    const fotoGrande = Buffer.concat([
      await imagenesDePrueba.png(),
      Buffer.alloc(5 * MB),
    ]);
    const e = await rechazo(subir(t, archivo(fotoGrande, 'a.png')));
    expect(e).toMatchObject({ status: 413, code: 'ATTACHMENT_TOO_LARGE' });
    expect(e.message).toBe('La foto supera el máximo permitido (5 MB)');
    expect(t.storage.put).not.toHaveBeenCalled();

    const pdfGrande = Buffer.concat([PDF, Buffer.alloc(6 * MB)]);
    await expect(subir(t, archivo(pdfGrande, 'a.pdf'))).resolves.toMatchObject({
      created: true,
    });
  });

  it('falta el archivo o está vacío: 400', async () => {
    const t = armar();
    expect(await rechazo(subir(t, undefined))).toMatchObject({
      status: 400,
      code: 'ATTACHMENT_MISSING',
      message: 'Falta el archivo',
    });
    expect(await rechazo(subir(t, archivo(Buffer.alloc(0))))).toMatchObject({
      status: 400,
      message: 'El archivo está vacío',
    });
  });

  it('con 30 adjuntos hoy en la empresa: 429 `ATTACHMENT_DAILY_LIMIT`, sin subir ni gastar cupo', async () => {
    const t = armar({ hoy: 30 });
    const e = await rechazo(subir(t, archivo(PDF, 'a.pdf')));
    expect(e).toMatchObject({ status: 429, code: 'ATTACHMENT_DAILY_LIMIT' });
    expect(t.storage.put).not.toHaveBeenCalled();
    expect(t.cupos.mensaje).not.toHaveBeenCalled();
    // El conteo es de esa persona en esa empresa, desde el comienzo del día.
    const [sql, params] = t.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('"message_id" IS NOT NULL');
    expect(sql).toContain("date_trunc('day'");
    expect(params).toEqual([D, 'cli-1', 'America/Argentina/Buenos_Aires']);
    expect(sql).not.toContain('America/');
  });

  it('29 adjuntos hoy: entra el 30', async () => {
    const t = armar({ hoy: 29 });
    await expect(subir(t, archivo(PDF, 'a.pdf'))).resolves.toMatchObject({
      created: true,
    });
  });

  it('el reintento con el mismo clientMessageId devuelve el mismo mensaje (200) sin volver a subir', async () => {
    const t = armar();
    const primero = await subir(t, archivo(PDF, 'a.pdf'));
    const segundo = await subir(t, archivo(PDF, 'a.pdf'));
    expect(segundo.created).toBe(false);
    expect(segundo.message.messageId).toBe(primero.message.messageId);
    expect(segundo.attachment?.attachmentId).toBe('adj-1');
    expect(t.storage.put).toHaveBeenCalledTimes(1);
    expect(t.cupos.mensaje).toHaveBeenCalledTimes(1);
  });

  it('reintento cuyo original se guardó mientras éste subía: 200 con ese mensaje aunque ya llegó al tope del día', async () => {
    const t = armar({ hoy: 29 });
    const original = {
      messageId: 'msg-original',
      conversationId: CONV,
      senderUserId: 'cli-1',
      clientMessageId: CMID,
      distributorId: D,
    } as Message;
    let consultas = 0;
    t.query.mockImplementation((sql: string) => {
      if (!sql.includes('count(*)')) return Promise.resolve([]);
      consultas += 1;
      // Antes de subir, 29; dentro de la transacción (el original ya se
      // guardó), 30.
      return Promise.resolve([{ n: consultas > 1 ? '30' : '29' }]);
    });
    // El original se guarda mientras éste sube.
    t.cleanup.reserveUpload.mockImplementation(() => {
      t.mensajes.push(original);
      return Promise.resolve();
    });
    const r = await subir(t, archivo(PDF, 'a.pdf'));
    expect(r.created).toBe(false);
    expect(r.message.messageId).toBe('msg-original');
    expect(t.escribir).not.toHaveBeenCalled();
    // Lo que subió este reintento sobra.
    expect(t.cleanup.removeInBackground).toHaveBeenCalledTimes(1);
  });

  it('una foto que al re-codificarse pasa el tope del canal es 413 y no se sube', async () => {
    const t = armar();
    const limpiar = jest
      .spyOn(limpieza, 'limpiarMetadatosDeImagen')
      .mockResolvedValue(Buffer.alloc(5 * MB + 1));
    try {
      const e = await rechazo(
        subir(t, archivo(await imagenesDePrueba.png(), 'a.png')),
      );
      expect(e).toMatchObject({
        status: 413,
        code: 'ATTACHMENT_TOO_LARGE',
        message: 'La foto supera el máximo permitido (5 MB)',
      });
      expect(t.storage.put).not.toHaveBeenCalled();
    } finally {
      limpiar.mockRestore();
    }
  });

  it('conversación cerrada: 409 antes de subir', async () => {
    const t = armar();
    await expect(
      subir(
        t,
        archivo(PDF, 'a.pdf'),
        conversacion({ status: ConversationStatus.CLOSED }),
      ),
    ).rejects.toBeInstanceOf(ConversacionCerradaError);
    expect(t.storage.put).not.toHaveBeenCalled();
  });

  it('si la transacción falla, el objeto subido se borra y no se publica nada', async () => {
    const t = armar({ falla: true });
    await expect(subir(t, archivo(PDF, 'a.pdf'))).rejects.toThrow(
      'se cayó la base',
    );
    const key = (
      (t.storage.put.mock.calls[0] as unknown[])[0] as { key: string }
    ).key;
    expect(t.cleanup.removeInBackground).toHaveBeenCalledWith(key);
    expect(t.cleanup.confirmUpload).not.toHaveBeenCalled();
    expect(t.eventos.publicar).not.toHaveBeenCalled();
  });

  it('si otro pedido con el mismo id ganó la carrera, el objeto sobrante se borra', async () => {
    const t = armar();
    const existente = { messageId: 'msg-9', distributorId: D } as Message;
    const escribir: EscribirElMensaje = () =>
      Promise.resolve({
        message: existente,
        created: false,
        conversation: conversacion(),
      });
    const r = await subir(t, archivo(PDF, 'a.pdf'), conversacion(), escribir);
    expect(r.created).toBe(false);
    expect(t.adjuntos).toHaveLength(0);
    expect(t.cleanup.removeInBackground).toHaveBeenCalledTimes(1);
    expect(t.escaneo.encolar).not.toHaveBeenCalled();
  });
});

describe('AdjuntosDelChat: leer (URL firmada)', () => {
  function conAdjunto(
    estado: AttachmentScanStatus,
    mensaje: Partial<Message> = {},
  ) {
    const t = armar();
    t.mensajes.push({
      messageId: 'msg-1',
      conversationId: CONV,
      distributorId: D,
      kind: MessageKind.ATTACHMENT,
      visibility: MessageVisibility.ALL,
      redactedAt: null,
      withdrawnAt: null,
      ...mensaje,
    } as Message);
    t.adjuntos.push({
      attachmentId: 'adj-1',
      ownerType: AttachmentOwnerType.CHAT_MESSAGE,
      messageId: 'msg-1',
      distributorId: D,
      storageKey: 'd/dist-a/chat/conv-1/x.pdf',
      originalName: 'remito.pdf',
      mimeType: 'application/pdf',
      scanStatus: estado,
    } as Attachment);
    return t;
  }
  const persona = { party: Party.CUSTOMER } as const;
  const personal = { party: Party.COMPANY } as const;

  it('limpio: la URL firmada con su vencimiento, para ver en pantalla', async () => {
    const t = conAdjunto(AttachmentScanStatus.CLEAN);
    await expect(
      t.servicio.enlace(conversacion(), 'msg-1', persona),
    ).resolves.toEqual({
      url: 'https://s3/firmada',
      expiresAt: new Date('2026-11-16T12:05:00Z'),
      requiresAuth: false,
    });
    expect(t.storage.getSignedDownload).toHaveBeenCalledWith(
      'd/dist-a/chat/conv-1/x.pdf',
      {
        fileName: 'remito.pdf',
        disposition: 'inline',
        contentType: 'application/pdf',
      },
    );
  });

  it('pendiente: 409 `ATTACHMENT_SCAN_PENDING` hasta que quede limpio', async () => {
    const t = conAdjunto(AttachmentScanStatus.PENDING);
    await expect(
      t.servicio.enlace(conversacion(), 'msg-1', personal),
    ).rejects.toBeInstanceOf(AdjuntoEnEscaneoError);
    expect(t.storage.getSignedDownload).not.toHaveBeenCalled();
  });

  it('infectado: oculto (404) también para el personal', async () => {
    const t = conAdjunto(AttachmentScanStatus.INFECTED);
    await expect(
      t.servicio.enlace(conversacion(), 'msg-1', personal),
    ).rejects.toBeInstanceOf(AdjuntoNoEncontradoError);
  });

  it('sin verificar (`failed`): 409 para todos, también el personal; nada se firma', async () => {
    const t = conAdjunto(AttachmentScanStatus.FAILED);
    await expect(
      t.servicio.enlace(conversacion(), 'msg-1', personal),
    ).rejects.toBeInstanceOf(AdjuntoSinVerificarError);
    await expect(
      t.servicio.enlace(conversacion(), 'msg-1', persona),
    ).rejects.toBeInstanceOf(AdjuntoSinVerificarError);
    expect(t.storage.getSignedDownload).not.toHaveBeenCalled();
  });

  it('redactado, de otra conversación, de otra empresa o sin adjunto: 404', async () => {
    const redactado = conAdjunto(AttachmentScanStatus.CLEAN, {
      redactedAt: new Date(),
    });
    await expect(
      redactado.servicio.enlace(conversacion(), 'msg-1', personal),
    ).rejects.toBeInstanceOf(AdjuntoNoEncontradoError);

    const t = conAdjunto(AttachmentScanStatus.CLEAN);
    await expect(
      t.servicio.enlace(
        conversacion({ conversationId: 'otra' }),
        'msg-1',
        personal,
      ),
    ).rejects.toBeInstanceOf(AdjuntoNoEncontradoError);
    await expect(
      t.servicio.enlace(
        conversacion({ distributorId: 'dist-b' }),
        'msg-1',
        personal,
      ),
    ).rejects.toBeInstanceOf(AdjuntoNoEncontradoError);

    const texto = conAdjunto(AttachmentScanStatus.CLEAN, {
      kind: MessageKind.TEXT,
    });
    await expect(
      texto.servicio.enlace(conversacion(), 'msg-1', personal),
    ).rejects.toBeInstanceOf(AdjuntoNoEncontradoError);
    expect(t.storage.getSignedDownload).not.toHaveBeenCalled();
  });

  it('el adjunto de una nota interna no lo ve la otra punta', async () => {
    const t = conAdjunto(AttachmentScanStatus.CLEAN, {
      visibility: MessageVisibility.INTERNAL,
    });
    await expect(
      t.servicio.enlace(conversacion(), 'msg-1', persona),
    ).rejects.toBeInstanceOf(AdjuntoNoEncontradoError);
  });
});

describe('nombreConSuExtension', () => {
  it('deja el nombre si la extensión es la del tipo; si no, agrega la que es', () => {
    expect(nombreConSuExtension('casa.JPEG', 'image/jpeg')).toBe('casa.JPEG');
    expect(nombreConSuExtension('casa', 'image/png')).toBe('casa.png');
    expect(nombreConSuExtension('remito.pdf', 'image/webp')).toBe(
      'remito.pdf.webp',
    );
    expect(nombreConSuExtension('  ', 'application/pdf')).toBe('archivo.pdf');
  });
});

describe('las medidas salen de la foto ya limpia', () => {
  it('una foto girada por EXIF guarda las medidas ya giradas', async () => {
    const t = armar();
    const r = await subir(
      t,
      archivo(await imagenesDePrueba.jpegGirado(), 'g.jpg'),
    );
    const subido = (
      (t.storage.put.mock.calls[0] as unknown[])[0] as { body: Buffer }
    ).body;
    const meta = await sharp(subido).metadata();
    expect([r.attachment?.width, r.attachment?.height]).toEqual([
      meta.width,
      meta.height,
    ]);
    expect(r.attachment?.width).toBe(20);
  });
});
