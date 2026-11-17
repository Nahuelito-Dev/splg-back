import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource, EntityManager } from 'typeorm';
import { AttachmentScanStatus } from '../../attachment/attachment-scan-status';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../attachment/entities/attachment.entity';
import type { EscanerDeArchivos } from '../../attachment/escaner/escaner-de-archivos.port';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../../common/events/notificar-admin.event';
import type { S3CleanupService } from '../../s3/s3-cleanup.service';
import type { S3Service } from '../../s3/s3.service';
import { Channel, Party } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import type { ChatEvents, Efectos } from './chat.events';
import {
  AVISO_ADJUNTO_BLOQUEADO,
  EscaneoDeAdjuntos,
  ESPERA_PARA_REINTENTAR_MS,
  PENDIENTE_OLVIDADO_MS,
} from './escaneo-de-adjuntos';
import {
  ESCANEOS_SIMULTANEOS,
  MAX_INTENTOS_DE_ESCANEO,
} from '../domain/adjuntos';
import { EscaneoDeAdjuntosCron } from './escaneo-de-adjuntos.cron';
import type { RedisService } from '../../redis/redis.service';

const EICAR = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);

function armar(
  opciones: {
    canal?: Channel;
    autor?: Party;
    escaneo?: (
      c: Buffer,
    ) => Promise<{ infectado: false } | { infectado: true; firma: string }>;
    actualizadas?: number;
    pendiente?: boolean;
    estado?: AttachmentScanStatus;
    intentos?: number;
  } = {},
) {
  const adjunto = {
    attachmentId: 'adj-1',
    ownerType: AttachmentOwnerType.CHAT_MESSAGE,
    messageId: 'msg-1',
    distributorId: 'dist-a',
    storageKey: 'd/dist-a/chat/conv-1/x.pdf',
    originalName: 'factura.pdf',
    uploadedByUserId: 'u-autor',
    scanStatus: opciones.estado ?? AttachmentScanStatus.PENDING,
    scanAttempts: opciones.intentos ?? 0,
  } as Attachment;
  const mensaje = {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    senderParty: opciones.autor ?? Party.CUSTOMER,
  } as Message;
  const conversacion = {
    conversationId: 'conv-1',
    distributorId: 'dist-a',
    channel: opciones.canal ?? Channel.STAFF_CUSTOMER,
  } as Conversation;
  const updates: unknown[][] = [];
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      updates.push([sql, params]);
      const n = opciones.actualizadas ?? 1;
      return Promise.resolve([
        Array.from({ length: n }, () => ({ attachment_id: 'adj-1' })),
        n,
      ]);
    }),
    getRepository: (e: unknown) => ({
      findOne: () => Promise.resolve(e === Message ? mensaje : conversacion),
    }),
  };
  const buscado: unknown[] = [];
  const dataSource = {
    getRepository: (e: unknown) => ({
      findOne: (o: unknown) =>
        buscado.push(o) &&
        Promise.resolve(
          e === Attachment && opciones.pendiente !== false ? adjunto : null,
        ),
    }),
    transaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) =>
      fn(manager as unknown as EntityManager),
    ),
    query: jest
      .fn()
      .mockResolvedValue([
        { attachment_id: 'adj-1' },
        { attachment_id: 'adj-2' },
      ]),
  };
  const storage = { get: jest.fn().mockResolvedValue(EICAR) };
  const cleanup = { scheduleRemoval: jest.fn().mockResolvedValue(undefined) };
  const escaner = {
    nombre: 'de prueba',
    escanear: jest.fn(
      opciones.escaneo ??
        ((c: Buffer) =>
          Promise.resolve(
            c.includes('EICAR')
              ? { infectado: true as const, firma: 'Eicar-Test-Signature' }
              : { infectado: false as const },
          )),
    ),
  };
  const publicados: Efectos[] = [];
  const eventos = { publicar: (e: Efectos) => publicados.push(e) };
  const avisos = { emit: jest.fn() };
  const servicio = new EscaneoDeAdjuntos(
    dataSource as unknown as DataSource,
    storage as unknown as S3Service,
    cleanup as unknown as S3CleanupService,
    escaner as unknown as EscanerDeArchivos,
    eventos as unknown as ChatEvents,
    avisos as unknown as EventEmitter2,
  );
  return {
    servicio,
    storage,
    cleanup,
    escaner,
    publicados,
    avisos,
    updates,
    dataSource,
    buscado,
  };
}

const avisosEmitidos = (t: ReturnType<typeof armar>) =>
  t.avisos.emit.mock.calls
    .filter(([nombre]) => nombre === EVENTO_NOTIFICAR_ADMIN)
    .map(([, e]) => e as NotificarAdminEvent);

describe('EscaneoDeAdjuntos', () => {
  it('EICAR → infectado: queda oculto, el objeto va a borrarse y avisa a la bandeja', async () => {
    const t = armar();
    await expect(t.servicio.escanear('adj-1', [])).resolves.toBe(
      AttachmentScanStatus.INFECTED,
    );
    expect(t.storage.get).toHaveBeenCalledWith('d/dist-a/chat/conv-1/x.pdf');
    const [sql, params] = t.updates[0] as [string, unknown[]];
    expect(params).toEqual(['adj-1', AttachmentScanStatus.INFECTED, 1]);
    // Sólo sobre lo pendiente o fallido y vigente: un infectado pisa un fallido.
    expect(sql).toContain(`"scan_status" IN ('pending', 'failed')`);
    expect(sql).toContain(`"deleted_at" IS NULL`);
    expect(sql).toContain(`"scan_attempts" = LEAST("scan_attempts" + $3, 50)`);
    expect(t.cleanup.scheduleRemoval).toHaveBeenCalledWith(
      expect.anything(),
      'd/dist-a/chat/conv-1/x.pdf',
    );
    // Las salas reciben el mensaje de nuevo (`chat:message`), sin tocar las listas.
    expect(t.publicados[0].actualizaciones).toHaveLength(1);
    expect(t.publicados[0].mensajes).toHaveLength(0);
    const avisos = avisosEmitidos(t);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      distributorId: 'dist-a',
      kind: AVISO_ADJUNTO_BLOQUEADO,
      link: { entity: 'conversation', id: 'conv-1' },
      recipientUserId: null,
    });
    expect(avisos[0].body).toContain('factura.pdf');
  });

  it('subido por el personal: además, un aviso sólo para quien lo subió', async () => {
    const t = armar({ autor: Party.COMPANY });
    await t.servicio.escanear('adj-1', []);
    const avisos = avisosEmitidos(t);
    expect(avisos.map((a) => a.recipientUserId)).toEqual([null, 'u-autor']);
  });

  it('en el soporte (C1): avisa a la empresa y a la plataforma', async () => {
    const t = armar({ canal: Channel.PLATFORM_TICKET });
    await t.servicio.escanear('adj-1', []);
    expect(avisosEmitidos(t).map((a) => a.distributorId)).toEqual([
      'dist-a',
      null,
    ]);
  });

  it('limpio: queda descargable, sin avisos ni borrado', async () => {
    const t = armar();
    t.storage.get.mockResolvedValue(Buffer.from('%PDF-1.4'));
    await expect(t.servicio.escanear('adj-1', [])).resolves.toBe(
      AttachmentScanStatus.CLEAN,
    );
    expect(t.cleanup.scheduleRemoval).not.toHaveBeenCalled();
    expect(avisosEmitidos(t)).toHaveLength(0);
    expect(t.publicados[0].actualizaciones).toHaveLength(1);
  });

  it('reintenta: dos fallas y al tercero sale', async () => {
    let veces = 0;
    const t = armar({
      escaneo: () =>
        ++veces < 3
          ? Promise.reject(new Error('clamd no responde'))
          : Promise.resolve({ infectado: false }),
    });
    await expect(t.servicio.escanear('adj-1', [0, 0])).resolves.toBe(
      AttachmentScanStatus.CLEAN,
    );
    expect(t.escaner.escanear).toHaveBeenCalledTimes(3);
  });

  it('tres fallas: queda `failed` (sin verificar)', async () => {
    const t = armar({
      escaneo: () => Promise.reject(new Error('clamd no responde')),
    });
    await expect(t.servicio.escanear('adj-1', [0, 0])).resolves.toBe(
      AttachmentScanStatus.FAILED,
    );
    expect(t.escaner.escanear).toHaveBeenCalledTimes(3);
    expect((t.updates[0] as [string, unknown[]])[1]).toEqual([
      'adj-1',
      AttachmentScanStatus.FAILED,
      3,
    ]);
    expect(t.cleanup.scheduleRemoval).not.toHaveBeenCalled();
  });

  it('si ya no estaba pendiente (lo terminó otro), no pisa nada ni avisa', async () => {
    const t = armar({ actualizadas: 0 });
    await expect(t.servicio.escanear('adj-1', [])).resolves.toBeNull();
    expect(t.cleanup.scheduleRemoval).not.toHaveBeenCalled();
    expect(t.publicados).toHaveLength(0);
    expect(avisosEmitidos(t)).toHaveLength(0);
  });

  it('un adjunto que no está pendiente no se escanea', async () => {
    const t = armar({ pendiente: false });
    await expect(t.servicio.escanear('adj-1', [])).resolves.toBeNull();
    expect(t.storage.get).not.toHaveBeenCalled();
  });

  it('olvidados: los pendientes de hace más de 2 minutos y los fallidos con intentos; nunca los dados de baja', async () => {
    const t = armar();
    const ahora = new Date('2026-11-16T12:00:00Z');
    await expect(t.servicio.olvidados(ahora)).resolves.toEqual([
      'adj-1',
      'adj-2',
    ]);
    const [sql, params] = t.dataSource.query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain(`"scan_status" = 'pending'`);
    expect(sql).toContain(`"scan_status" = 'failed' AND "scan_attempts" < $3`);
    expect(sql).toContain(`"deleted_at" IS NULL`);
    expect(params).toEqual([
      new Date(ahora.getTime() - PENDIENTE_OLVIDADO_MS),
      20,
      MAX_INTENTOS_DE_ESCANEO,
      new Date(ahora.getTime() - ESPERA_PARA_REINTENTAR_MS),
    ]);
  });

  it('un `failed` con intentos se reintenta y, si encuentra el virus, queda infectado (infected gana sobre failed)', async () => {
    const t = armar({ estado: AttachmentScanStatus.FAILED, intentos: 3 });
    await expect(t.servicio.escanear('adj-1', [])).resolves.toBe(
      AttachmentScanStatus.INFECTED,
    );
    expect(t.cleanup.scheduleRemoval).toHaveBeenCalled();
    expect(avisosEmitidos(t)).toHaveLength(1);
  });

  it('un `failed` sin intentos ya no se escanea', async () => {
    const t = armar({
      estado: AttachmentScanStatus.FAILED,
      intentos: MAX_INTENTOS_DE_ESCANEO,
    });
    await expect(t.servicio.escanear('adj-1', [])).resolves.toBeNull();
    expect(t.storage.get).not.toHaveBeenCalled();
  });

  it('busca sólo los `pending` y `failed` (los dados de baja los saca TypeORM)', async () => {
    const t = armar();
    await t.servicio.escanear('adj-1', []);
    expect(JSON.stringify(t.buscado[0])).toContain('pending');
    expect(JSON.stringify(t.buscado[0])).toContain('failed');
    expect(JSON.stringify(t.buscado[0])).not.toContain('withDeleted');
  });

  it(`a lo sumo ${ESCANEOS_SIMULTANEOS} escaneos a la vez`, async () => {
    let enCurso = 0;
    let maximo = 0;
    const t = armar({
      escaneo: async () => {
        enCurso += 1;
        maximo = Math.max(maximo, enCurso);
        await new Promise((r) => setTimeout(r, 20));
        enCurso -= 1;
        return { infectado: false };
      },
    });
    await Promise.all(
      Array.from({ length: 6 }, () => t.servicio.escanear('adj-1', [])),
    );
    expect(t.escaner.escanear).toHaveBeenCalledTimes(6);
    expect(maximo).toBe(ESCANEOS_SIMULTANEOS);
  });
});

describe('EscaneoDeAdjuntosCron', () => {
  it('escanea los olvidados de a uno; el que falla no frena a los demás', async () => {
    const escaneo = {
      olvidados: jest.fn().mockResolvedValue(['a', 'b', 'c']),
      escanear: jest
        .fn()
        .mockResolvedValueOnce(AttachmentScanStatus.CLEAN)
        .mockRejectedValueOnce(new Error('S3 caído'))
        .mockResolvedValueOnce(null),
    };
    const cron = new EscaneoDeAdjuntosCron(
      {} as RedisService,
      escaneo as unknown as EscaneoDeAdjuntos,
    );
    await expect(cron.barrer(new Date())).resolves.toEqual({ scanned: 1 });
    expect(escaneo.escanear).toHaveBeenCalledTimes(3);
  });

  it('con el cerrojo tomado por otra instancia no hace nada', async () => {
    const escaneo = { olvidados: jest.fn() };
    const redis = {
      withLock: jest.fn().mockResolvedValue({ obtenido: false }),
    };
    const cron = new EscaneoDeAdjuntosCron(
      redis as unknown as RedisService,
      escaneo as unknown as EscaneoDeAdjuntos,
    );
    await expect(cron.retomar()).resolves.toBeUndefined();
    expect(escaneo.olvidados).not.toHaveBeenCalled();
  });
});
