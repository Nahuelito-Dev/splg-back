import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AttachmentScanStatus } from '../../attachment/attachment-scan-status';
import {
  Attachment,
  AttachmentOwnerType,
} from '../../attachment/entities/attachment.entity';
import {
  acotarNombreDeArchivo,
  decodificarNombreDeArchivo,
  extensionParaMimeType,
  tipoPorContenido,
  type AllowedDocumentMimeType,
} from '../../common/utils/attachment-rules';
import { aEnlaceDeDescarga } from '../../s3/download-link';
import type { DownloadLinkResponseDto } from '../../s3/dto/download-link.dto';
import {
  limpiarMetadatosDeImagen,
  medidasDeImagen,
} from '../../s3/limpiar-imagen';
import { S3CleanupService } from '../../s3/s3-cleanup.service';
import { S3Service } from '../../s3/s3.service';
import {
  ADJUNTOS_POR_DIA,
  escaneoInicial,
  lecturaDelAdjunto,
  medioDe,
  reglaDeAdjuntos,
  topeDe,
  type MedioDelAdjunto,
} from '../domain/adjuntos';
import {
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  type PartyQueHabla,
} from '../domain/chat.enums';
import {
  AdjuntoEnEscaneoError,
  AdjuntoNoEncontradoError,
  AdjuntoSinVerificarError,
  ConversacionCerradaError,
} from '../domain/chat.errors';
import { veNotasInternas } from '../domain/reglas-del-mensaje';
import type { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import type { SendAttachmentDto } from '../presentation/dto/chat-attachment.dto';
import {
  archivoVacio,
  conCodigoDeLaFoto,
  demasiadoGrande,
  faltaElArchivo,
  tipoNoPermitido,
  topeDelDia,
} from './adjuntos.errors';
import { ChatEvents, Efectos } from './chat.events';
import { ChatRateLimit } from './chat-rate-limit';
import { EscaneoDeAdjuntos } from './escaneo-de-adjuntos';
import type { NuevoMensaje } from './mensajes.port';
import type { MensajeEscrito } from './message-writer';

/** Zona del «por día» del tope de adjuntos. */
const ZONA = 'America/Argentina/Buenos_Aires';

/** Un pedido de subida: la conversación ya la buscó (y autorizó) quien llama. */
export interface PedidoDeAdjunto {
  conversation: Conversation;
  party: PartyQueHabla;
  userId: string;
  archivo: Express.Multer.File | undefined;
  dto: SendAttachmentDto;
  /** El cupo del chat (mensajes por minuto): la empresa y, para la persona, la conversación. */
  cupo: { ambito: string; conversacion?: string };
}

/**
 * Escribe el mensaje dentro de la transacción de la subida, con lo que el
 * canal haga al escribir (bloquear el ticket, primera respuesta, estado):
 * quien llama pone el `MessageWriter` y sus efectos.
 */
export type EscribirElMensaje = (
  manager: EntityManager,
  nuevo: NuevoMensaje,
  efectos: Efectos,
) => Promise<MensajeEscrito>;

export interface AdjuntoEscrito extends MensajeEscrito {
  attachment: Attachment | null;
}

/** El archivo ya validado y limpio, listo para subir. */
interface ArchivoListo {
  cuerpo: Buffer;
  mime: AllowedDocumentMimeType;
  medio: MedioDelAdjunto;
  nombre: string;
  width: number | null;
  height: number | null;
}

/** Quién pide la URL: su punta (decide si ve las notas internas). */
export interface LectorDelAdjunto {
  party: PartyQueHabla;
}

/**
 * Adjuntos del chat (CH7, diseño §9), para todos los canales:
 *
 * - **Subir** (§9.1): reintento con el mismo `clientMessageId` → el mismo
 *   mensaje (200, sin volver a subir); tipo por el contenido (no por la
 *   extensión) según el canal (§9.2, 415); tope por tipo (413); tope de 30
 *   por persona, empresa y día (429); foto re-codificada sin EXIF (una que
 *   no se lee, 415). La key se reserva en `storage_orphan`, se sube con SSE
 *   y el mensaje (`kind = 'attachment'`) y el adjunto se guardan en una sola
 *   transacción que confirma la reserva: si algo falla, el objeto se borra.
 *   Un PDF o documento queda `pending` y se escanea después del commit.
 * - **Leer** (§9.4): la URL firmada (300 s) del adjunto de un mensaje de la
 *   conversación que quien llama ya autorizó. Redactado, de otra
 *   conversación o bloqueado por virus → 404; `pending` → 409.
 */
@Injectable()
export class AdjuntosDelChat {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: S3Service,
    private readonly cleanup: S3CleanupService,
    private readonly cupos: ChatRateLimit,
    private readonly eventos: ChatEvents,
    private readonly escaneo: EscaneoDeAdjuntos,
  ) {}

  async subir(
    pedido: PedidoDeAdjunto,
    escribir: EscribirElMensaje,
  ): Promise<AdjuntoEscrito> {
    const c = pedido.conversation;
    const previo = await this.yaEscrito(
      this.dataSource.manager,
      c,
      pedido.userId,
      pedido.dto.clientMessageId,
    );
    if (previo) return previo;
    if (c.status !== ConversationStatus.OPEN) {
      throw new ConversacionCerradaError();
    }
    const archivo = await this.preparar(c, pedido.archivo);
    await this.assertTopeDelDia(
      this.dataSource.manager,
      c.distributorId,
      pedido.userId,
    );
    await this.cupos.mensaje({
      ambito: pedido.cupo.ambito,
      userId: pedido.userId,
      clientMessageId: pedido.dto.clientMessageId,
      conversacion: pedido.cupo.conversacion,
    });

    const key = `d/${c.distributorId}/chat/${c.conversationId}/${randomUUID()}.${extensionParaMimeType(archivo.mime)}`;
    // La key se anota antes de subir: si el proceso cae antes del commit, el
    // cron borra el objeto abandonado.
    await this.cleanup.reserveUpload(key);
    await this.storage.put({
      key,
      body: archivo.cuerpo,
      contentType: archivo.mime,
    });

    const efectos = new Efectos();
    let r: AdjuntoEscrito;
    try {
      r = await this.dataSource.transaction(async (manager) => {
        // El tope del día, otra vez y de a una subida por persona y empresa:
        // dos subidas simultáneas no lo pasan.
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `chat-adjuntos:${c.distributorId}:${pedido.userId}`,
        ]);
        // Un reintento cuyo original se guardó mientras éste subía: es el
        // mismo mensaje (200), aunque ese adjunto haya completado el tope.
        const yaGuardado = await this.yaEscrito(
          manager,
          c,
          pedido.userId,
          pedido.dto.clientMessageId,
        );
        if (yaGuardado) return yaGuardado;
        await this.assertTopeDelDia(manager, c.distributorId, pedido.userId);
        const escrito = await escribir(
          manager,
          {
            conversationId: c.conversationId,
            distributorId: c.distributorId,
            senderParty: pedido.party,
            senderUserId: pedido.userId,
            clientMessageId: pedido.dto.clientMessageId,
            kind: MessageKind.ATTACHMENT,
            visibility: MessageVisibility.ALL,
            body: pedido.dto.caption ?? null,
            payload: { media: archivo.medio },
            systemCode: null,
            templateKey: null,
          },
          efectos,
        );
        if (!escrito.created) {
          return {
            ...escrito,
            attachment: await this.adjuntoDe(manager, escrito.message),
          };
        }
        const repo = manager.getRepository(Attachment);
        const attachment = await repo.save(
          repo.create({
            distributorId: c.distributorId,
            ownerType: AttachmentOwnerType.CHAT_MESSAGE,
            ownerId: escrito.message.messageId,
            messageId: escrito.message.messageId,
            label: null,
            storageKey: key,
            originalName: archivo.nombre,
            mimeType: archivo.mime,
            sizeBytes: archivo.cuerpo.length,
            uploadedByUserId: pedido.userId,
            scanStatus: escaneoInicial(archivo.mime),
            width: archivo.width,
            height: archivo.height,
          }),
        );
        await this.cleanup.confirmUpload(manager, key);
        return { ...escrito, attachment };
      });
    } catch (error) {
      // El archivo ya se subió: sin mensaje, no queda en el bucket.
      this.cleanup.removeInBackground(key);
      throw error;
    }
    // Otro pedido con el mismo `clientMessageId` ganó la carrera: este objeto sobra.
    if (!r.created) this.cleanup.removeInBackground(key);
    this.eventos.publicar(efectos);
    if (
      r.created &&
      r.attachment?.scanStatus === AttachmentScanStatus.PENDING
    ) {
      this.escaneo.encolar(r.attachment.attachmentId);
    }
    return r;
  }

  /**
   * La URL firmada del adjunto del mensaje `messageId` de la conversación `c`
   * (ya autorizada para quien pide).
   */
  async enlace(
    c: Conversation,
    messageId: string,
    lector: LectorDelAdjunto,
  ): Promise<DownloadLinkResponseDto> {
    const m = await this.dataSource.getRepository(Message).findOne({
      where: {
        messageId,
        conversationId: c.conversationId,
        distributorId: c.distributorId,
      },
    });
    if (
      !m ||
      m.kind !== MessageKind.ATTACHMENT ||
      m.redactedAt !== null ||
      m.withdrawnAt !== null ||
      (m.visibility !== MessageVisibility.ALL &&
        !veNotasInternas(lector.party, c.channel))
    ) {
      throw new AdjuntoNoEncontradoError();
    }
    const a = await this.adjuntoDe(this.dataSource.manager, m);
    if (!a) throw new AdjuntoNoEncontradoError();
    switch (lecturaDelAdjunto(a.scanStatus)) {
      case 'pendiente':
        throw new AdjuntoEnEscaneoError();
      case 'bloqueado':
        throw new AdjuntoNoEncontradoError();
      case 'fallido':
        throw new AdjuntoSinVerificarError();
      case 'firmar':
        break;
    }
    return aEnlaceDeDescarga(
      await this.storage.getSignedDownload(a.storageKey, {
        fileName: a.originalName,
        // Fotos y PDF se ven en pantalla; el resto se baja siempre.
        disposition: 'inline',
        contentType: a.mimeType,
      }),
    );
  }

  /** Tipo por el contenido, tope del canal y foto limpia (sin EXIF), antes de subir nada. */
  private async preparar(
    c: Conversation,
    archivo: Express.Multer.File | undefined,
  ): Promise<ArchivoListo> {
    if (!archivo) throw faltaElArchivo();
    if (archivo.size === 0 || archivo.buffer.length === 0) {
      throw archivoVacio();
    }
    const regla = reglaDeAdjuntos(c.channel);
    const nombre = decodificarNombreDeArchivo(archivo.originalname);
    const mime = tipoPorContenido(archivo.buffer, nombre, archivo.mimetype);
    if (!mime || !regla.tipos.includes(mime)) {
      throw tipoNoPermitido(regla.tiposEnTexto);
    }
    const medio = medioDe(mime);
    const tope = topeDe(regla, mime);
    if (archivo.buffer.length > tope) throw demasiadoGrande(medio, tope);
    let cuerpo: Buffer;
    try {
      cuerpo = await limpiarMetadatosDeImagen(archivo.buffer, mime);
    } catch (error) {
      throw conCodigoDeLaFoto(error);
    }
    // La foto re-codificada puede pesar más que la original: el tope del
    // canal se controla también sobre lo que se guarda.
    if (cuerpo.length > tope) throw demasiadoGrande(medio, tope);
    const medidas =
      medio === 'photo'
        ? await medidasDeImagen(cuerpo)
        : { width: null, height: null };
    return {
      cuerpo,
      mime,
      medio,
      nombre: acotarNombreDeArchivo(nombreConSuExtension(nombre, mime)),
      ...medidas,
    };
  }

  /** 429 si la persona ya subió 30 adjuntos hoy en esa empresa (cuentan también los redactados). */
  private async assertTopeDelDia(
    manager: EntityManager,
    distributorId: string,
    userId: string,
  ): Promise<void> {
    const [fila]: Array<{ n: string }> = await manager.query(
      `SELECT count(*) AS n FROM "attachment"
        WHERE "distributor_id" = $1 AND "uploaded_by_user_id" = $2
          AND "message_id" IS NOT NULL
          AND "uploaded_at" >= (date_trunc('day', now() AT TIME ZONE ($3)::text) AT TIME ZONE ($3)::text)`,
      [distributorId, userId, ZONA],
    );
    if (Number(fila?.n ?? 0) >= ADJUNTOS_POR_DIA) throw topeDelDia();
  }

  /** El mensaje de ese autor con ese `clientMessageId` en esa conversación (reintento → 200). */
  private async yaEscrito(
    manager: EntityManager,
    c: Conversation,
    userId: string,
    clientMessageId: string,
  ): Promise<AdjuntoEscrito | null> {
    const message = await manager.getRepository(Message).findOne({
      where: {
        conversationId: c.conversationId,
        senderUserId: userId,
        clientMessageId,
      },
    });
    if (!message) return null;
    return {
      message,
      created: false,
      conversation: c,
      attachment: await this.adjuntoDe(manager, message),
    };
  }

  private adjuntoDe(
    manager: EntityManager,
    m: Pick<Message, 'messageId' | 'distributorId'>,
  ): Promise<Attachment | null> {
    return manager.getRepository(Attachment).findOne({
      where: {
        ownerType: AttachmentOwnerType.CHAT_MESSAGE,
        messageId: m.messageId,
        distributorId: m.distributorId,
      },
    });
  }
}

/** Extensiones que corresponden a cada tipo (la primera es la que se agrega). */
const EXTENSIONES: Record<AllowedDocumentMimeType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    'docx',
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'text/csv': ['csv'],
};

/**
 * El nombre con la extensión de lo que el archivo ES: una foto que llegó como
 * `remito.pdf` se guarda `remito.pdf.jpg` (quien la baja no se lleva un PNG
 * con nombre de PDF).
 */
export function nombreConSuExtension(
  nombre: string,
  mime: AllowedDocumentMimeType,
): string {
  const limpio = nombre.trim() || 'archivo';
  const punto = limpio.lastIndexOf('.');
  const ext = punto > 0 ? limpio.slice(punto + 1).toLowerCase() : '';
  const validas = EXTENSIONES[mime];
  return validas.includes(ext) ? limpio : `${limpio}.${validas[0]}`;
}
