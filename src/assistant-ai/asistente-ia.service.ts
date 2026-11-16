import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AssistantFaqService } from '../assistant/assistant-faq.service';
import { AsistenteDelChat } from '../chat/application/asistente-del-chat';
import { ChatEvents, Efectos } from '../chat/application/chat.events';
import { ChatViewsService } from '../chat/application/chat-views.service';
import {
  CompanyChatSettingsService,
  horarioDe,
  textoDeDerivacion,
} from '../chat/application/company-chat-settings.service';
import { MessageWriter } from '../chat/application/message-writer';
import { RespuestasFijas } from '../chat/application/respuestas-fijas';
import { SupportSettingsService } from '../chat/application/support-settings.service';
import { valoresDePlantilla } from '../chat/application/valores-de-plantilla';
import { puntasDelAsistente } from '../chat/domain/asistente-del-hilo';
import { completarPlantilla, nombreDelAsistente } from '../chat/domain/bandeja';
import {
  Channel,
  MessageKind,
  MessageVisibility,
  Party,
} from '../chat/domain/chat.enums';
import { ConversacionCerradaError } from '../chat/domain/chat.errors';
import { estaAbierto, proximaApertura } from '../chat/domain/horario';
import {
  atiendeLaEmpresa,
  textoDeLaProximaAtencion,
} from '../chat/domain/horario-de-la-empresa';
import type { ChatCompanySettings } from '../chat/entities/chat-company-settings.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { Message } from '../chat/entities/message.entity';
import type { PlatformSupportSettings } from '../chat/entities/platform-support-settings.entity';
import { codigoSqlDelError } from '../common/errors/db-exceptions';
import { errorMessage } from '../common/errors/error-message';
import {
  registrarElementoBien,
  registrarFallaDeElemento,
} from '../process-run/process-run.context';
import { RedisService } from '../redis/redis.service';
import {
  DERIVACIONES_SIN_IA,
  HORAS_QUE_MIRA_EL_RESCATE,
  MENSAJES_DE_CONTEXTO,
  MotivoDeDerivacion,
  SEGUNDOS_PARA_RESCATAR,
  TOPE_DEL_RESCATE,
  TOPE_DEL_RESCATE_POR_EMPRESA,
  MotivoDeDescarte,
  ResultadoDelAsistente,
  type RespuestaDelModelo,
  SIN_USO,
  type TokensDelMes,
  tokensQueCuentan,
  topeAlcanzado,
  type TopesDelAsistente,
} from './asistente-ia.dominio';
import { ConsultaAlAsistente } from './consulta-al-modelo';
import { AssistantTrace } from './entities/assistant-trace.entity';
import { herramientasDelCanal, HerramientasDelAsistente } from './herramientas';
import {
  armarMensajes,
  armarSystem,
  type CanalDelAsistente,
  type MensajeDelHilo,
} from './prompt';

const UNICO_VIOLADO = '23505';

/** Lock de Redis: una respuesta en curso por conversación. */
const TTL_DEL_LOCK_MS = 30_000;
/** Cuánto espera un mensaje a que termine la respuesta anterior (4 consultas de 8 s y un margen). */
const ESPERA_DEL_LOCK_MS = 40_000;

/** Clave de la respuesta del asistente y de su derivación en el mensaje. */
export const PLANTILLA_DEL_ASISTENTE = 'asistente_ia';
export const PLANTILLA_DE_DERIVACION = 'asistente_derivacion';

/** El mensaje de la otra punta que dispara al asistente. */
export interface MensajeEntrante {
  conversation: Conversation;
  message: Message;
}

/** Cómo es cada canal para el asistente. */
interface PerfilDelCanal {
  canal: CanalDelAsistente;
  /** Quién pregunta (el cliente en C3, la empresa en C1). */
  pregunta: Party;
}

/**
 * El perfil del canal si el mensaje es de los que atiende el asistente: texto
 * de la otra punta en C3 o en C1 (nunca C2, C4 ni tickets, §2). `null` si no.
 */
export function perfilSiCorresponde(
  conversation: Pick<Conversation, 'channel'>,
  message: Pick<Message, 'senderParty' | 'kind' | 'visibility' | 'body'>,
): PerfilDelCanal | null {
  const puntas = puntasDelAsistente(conversation.channel);
  if (!puntas) return null;
  if (message.senderParty !== puntas.pregunta) return null;
  if (message.kind !== MessageKind.TEXT) return null;
  if (message.visibility !== MessageVisibility.ALL) return null;
  if (!message.body) return null;
  return {
    canal:
      conversation.channel === Channel.PLATFORM_CHAT ? 'soporte' : 'clientes',
    pregunta: puntas.pregunta,
  };
}

/** Firma, textos, horario y topes de quien atiende. */
interface Atencion {
  ajustes: ChatCompanySettings | null;
  soporte: PlatformSupportSettings;
  nombreDeQuienAtiende: string;
  senderLabel: string;
  topes: TopesDelAsistente;
}

/** Cómo terminó la publicación. */
type Desenlace =
  | { publicado: true; replyMessageId: string | null }
  | { publicado: false; motivo: MotivoDeDescarte };

/**
 * Capa inteligente del asistente del chat (DISENO-CH-BOT §4, B3). Atiende un
 * mensaje de la otra punta DESPUÉS del commit de su envío (el envío nunca
 * espera ni falla por esto) y publica la respuesta como `auto_reply` firmada,
 * o deriva: aviso de derivación (con cuándo vuelve el equipo si está fuera de
 * horario), conversación «esperando persona» y aviso al equipo por el socket
 * de la bandeja. Si la IA no corre (tope o falla de la API), salen las
 * respuestas fijas de siempre (el envío no las mandó porque la IA se
 * encargaba) y se deriva.
 *
 * Una respuesta en curso por conversación (lock de Redis). La regla de cuándo
 * contesta es la de `AsistenteDelChat` (la misma del envío), mirada antes de
 * consultar y de nuevo, con la conversación bloqueada, antes de publicar.
 * Toda consulta al modelo deja traza con sus tokens, también la descartada.
 * Nunca tira.
 */
@Injectable()
export class AsistenteIaService {
  private readonly logger = new Logger(AsistenteIaService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly chat: AsistenteDelChat,
    private readonly ajustesDeLaEmpresa: CompanyChatSettingsService,
    private readonly ajustesDelSoporte: SupportSettingsService,
    private readonly vistas: ChatViewsService,
    private readonly base: AssistantFaqService,
    private readonly writer: MessageWriter,
    private readonly fijas: RespuestasFijas,
    private readonly eventos: ChatEvents,
    private readonly consulta: ConsultaAlAsistente,
    private readonly herramientas: HerramientasDelAsistente,
  ) {}

  async atender(
    entrante: MensajeEntrante,
    ahora: () => Date = () => new Date(),
  ): Promise<void> {
    const { conversation: c, message: m } = entrante;
    const perfil = perfilSiCorresponde(c, m);
    if (!perfil) return;
    try {
      if (!(await this.chat.prendido(c))) return;
      const atencion = await this.atencion(c, perfil);
      const r = await this.redis.withLock(
        `asistente:${c.conversationId}`,
        TTL_DEL_LOCK_MS,
        () => this.atenderConLock(c, m, perfil, atencion, ahora),
        ESPERA_DEL_LOCK_MS,
      );
      if (!r.obtenido) {
        this.logger.warn(
          `El asistente no pudo tomar la conversación ${c.conversationId}: sigue sin respuesta automática`,
        );
      }
    } catch (error) {
      this.logger.error(
        `El asistente falló en la conversación ${c.conversationId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Rescate (lo corre `AsistenteIaRescateCron` cada minuto): los mensajes de
   * la otra punta de hace más de 60 s (y menos de 24 h) que siguen siendo el
   * último de su conversación abierta, sin nadie que la atienda ni espera de
   * persona, sin respuesta publicada del asistente y con la IA prendida. El
   * envío no les mandó la fija porque la IA se encargaba y su trabajo no
   * corrió (el proceso se cayó, no tomó el lock). A cada uno: la fija que
   * corresponda y derivar, sin consultar al modelo (traza `handed_off` /
   * `not_processed`). Idempotente: la regla se vuelve a mirar con la
   * conversación bloqueada y el único parcial del disparador no deja publicar
   * dos veces. Antes, apaga el interruptor de las empresas que perdieron la
   * función (vencimiento de la excepción). Devuelve cuántos derivó.
   *
   * Aislado entre empresas: la consulta trae sólo conversaciones con la IA
   * prendida (en C3, el interruptor y el chat de clientes de la empresa, que
   * tras el apagado de arriba implica la función habilitada; en C1, el del
   * soporte), así los pendientes de una empresa sin IA no ocupan la corrida;
   * y reparte la corrida por turnos entre empresas y canales (el chat de una
   * empresa con sus clientes y su chat con el soporte no se tapan), con un
   * tope por empresa y canal, así una con muchos pendientes no deja esperando
   * a las demás.
   */
  async rescatarSinAtender(ahora: Date = new Date()): Promise<number> {
    const apagadas = await this.chat.apagarDondeNoEstaHabilitado(
      this.dataSource.manager,
    );
    if (apagadas > 0) {
      this.logger.log(
        `Rescate del asistente: se apagó el asistente de ${apagadas} empresa(s) que ya no tienen la función`,
      );
    }
    const soportePrendido = (await this.ajustesDelSoporte.leer())
      .assistantAiEnabled;
    const candidatos: Array<{ conversation_id: string; message_id: string }> =
      await this.dataSource.query(
        `SELECT "conversation_id", "message_id" FROM (
         SELECT c."conversation_id", m."message_id", m."created_at",
                row_number() OVER (PARTITION BY c."distributor_id", c."channel" ORDER BY m."created_at", m."message_id") AS "turno"
           FROM "conversation" c
           JOIN "message" m ON m."conversation_id" = c."conversation_id"
                           AND m."seq" = c."last_message_seq"
           LEFT JOIN "chat_company_settings" s ON s."distributor_id" = c."distributor_id"
          WHERE c."status" = 'open' AND c."deleted_at" IS NULL
            AND c."assigned_to_user_id" IS NULL AND c."awaiting_human_since" IS NULL
            AND c."channel" IN ('staff_customer', 'platform_chat')
            AND m."kind" = 'text' AND m."visibility" = 'all'
            AND m."sender_party" = CASE c."channel" WHEN 'staff_customer' THEN 'customer' ELSE 'company' END
            AND m."withdrawn_at" IS NULL AND m."redacted_at" IS NULL AND m."deleted_at" IS NULL
            AND m."created_at" < $1 AND m."created_at" >= $2
            AND CASE c."channel"
                  WHEN 'staff_customer' THEN COALESCE(s."assistant_ai_enabled" AND s."customer_chat_enabled", false)
                  ELSE $3::boolean
                END
            AND NOT EXISTS (SELECT 1 FROM "assistant_trace" t
                             WHERE t."trigger_message_id" = m."message_id"
                               AND t."outcome" <> '${ResultadoDelAsistente.DISCARDED}')
         ) x
          WHERE "turno" <= ${TOPE_DEL_RESCATE_POR_EMPRESA}
          ORDER BY "turno", "created_at", "message_id"
          LIMIT ${TOPE_DEL_RESCATE}`,
        [
          new Date(ahora.getTime() - SEGUNDOS_PARA_RESCATAR * 1000),
          new Date(ahora.getTime() - HORAS_QUE_MIRA_EL_RESCATE * 3_600_000),
          soportePrendido,
        ],
      );
    let derivados = 0;
    for (const { conversation_id, message_id } of candidatos) {
      try {
        if (await this.rescatar(conversation_id, message_id, ahora)) {
          derivados += 1;
        }
        registrarElementoBien(`mensaje:${message_id}`);
      } catch (error) {
        registrarFallaDeElemento(`mensaje:${message_id}`, error);
        this.logger.error(
          `Rescate del asistente: falló la conversación ${conversation_id}: ${errorMessage(error)}`,
        );
      }
    }
    return derivados;
  }

  private async rescatar(
    conversationId: string,
    messageId: string,
    ahora: Date,
  ): Promise<boolean> {
    const c = await this.dataSource
      .getRepository(Conversation)
      .findOne({ where: { conversationId } });
    const m = await this.dataSource
      .getRepository(Message)
      .findOne({ where: { messageId, conversationId } });
    if (!c || !m) return false;
    const perfil = perfilSiCorresponde(c, m);
    if (!perfil || !(await this.chat.prendido(c))) return false;
    const atencion = await this.atencion(c, perfil);
    // Sin esperar: si un trabajo tiene la conversación, todavía la está atendiendo.
    const r = await this.redis.withLock(
      `asistente:${c.conversationId}`,
      TTL_DEL_LOCK_MS,
      () =>
        this.publicar(
          c,
          m,
          perfil,
          atencion,
          {
            tipo: 'derivar',
            motivo: MotivoDeDerivacion.NOT_PROCESSED,
            modelo: null,
            uso: SIN_USO,
            herramientas: [],
          },
          Date.now(),
          ahora,
        ),
    );
    return r.obtenido && r.valor;
  }

  private async atencion(
    c: Conversation,
    perfil: PerfilDelCanal,
  ): Promise<Atencion> {
    const soporte = await this.ajustesDelSoporte.leer();
    const topes: TopesDelAsistente = {
      respuestasPorConversacion: soporte.assistantRepliesPerConversation,
      tokensPorMes: soporte.assistantMonthlyTokenLimit,
      tokensPorMesPorEmpresa:
        perfil.canal === 'soporte'
          ? soporte.assistantMonthlyTokenLimitPerCompany
          : null,
    };
    if (perfil.canal === 'soporte') {
      const plataforma = this.vistas.nombreDeLaPlataforma();
      return {
        ajustes: null,
        soporte,
        nombreDeQuienAtiende: plataforma,
        senderLabel: `Asistente de ${plataforma}`,
        topes,
      };
    }
    const ajustes = await this.ajustesDeLaEmpresa.leer(c.distributorId);
    // El nombre con que la conocen sus clientes (marca vigente o legal), como B1.
    const empresa = await this.ajustesDeLaEmpresa.nombreDeLaEmpresa(
      c.distributorId,
    );
    return {
      ajustes,
      soporte,
      nombreDeQuienAtiende: empresa,
      senderLabel: nombreDelAsistente(ajustes.assistantName, empresa),
      topes,
    };
  }

  private async atenderConLock(
    c: Conversation,
    m: Message,
    perfil: PerfilDelCanal,
    atencion: Atencion,
    ahora: () => Date,
  ): Promise<void> {
    const inicio = Date.now();
    const actual = await this.dataSource.getRepository(Conversation).findOne({
      where: {
        conversationId: c.conversationId,
        distributorId: c.distributorId,
      },
    });
    if (!actual) return;
    if (await this.yaPublicado(m.messageId)) return;
    if (
      await this.chat.motivoParaCallarse(
        this.dataSource.manager,
        actual,
        m,
        ahora(),
      )
    ) {
      return;
    }
    const tope = topeAlcanzado(
      atencion.topes,
      await this.consultasEnLaConversacion(c.conversationId),
      await this.tokensDelMes(c, perfil),
    );
    let resultado: RespuestaDelModelo;
    if (tope) {
      resultado = {
        tipo: 'derivar',
        motivo: tope,
        modelo: null,
        uso: SIN_USO,
        herramientas: [],
      };
    } else {
      const mensajes = armarMensajes(
        await this.hilo(c.conversationId),
        perfil.pregunta,
      );
      if (mensajes.length === 0) return;
      const { items } = await this.base.listar(
        perfil.canal === 'soporte' ? null : c.distributorId,
      );
      const momento = ahora();
      const ajustes = atencion.ajustes;
      resultado = await this.consulta.consultar({
        system: armarSystem(
          {
            canal: perfil.canal,
            nombreDelAsistente: atencion.senderLabel,
            nombreDeQuienAtiende: atencion.nombreDeQuienAtiende,
          },
          items,
        ),
        mensajes,
        herramientas: herramientasDelCanal(perfil.canal),
        ejecutar: (nombre, input) =>
          perfil.canal === 'soporte' || !ajustes
            ? Promise.resolve({
                datos: { error: 'Esa herramienta no está disponible acá' },
                error: true,
              })
            : this.herramientas.ejecutar(
                {
                  distributorId: c.distributorId,
                  customerUserId: c.customerUserId,
                  orderId: c.orderId,
                  ajustes,
                  ahora: momento,
                },
                nombre,
                input,
              ),
      });
    }
    await this.publicar(c, m, perfil, atencion, resultado, inicio, ahora());
  }

  /** Ya hay una respuesta o derivación publicada para ese mensaje. */
  private async yaPublicado(triggerMessageId: string): Promise<boolean> {
    const [fila]: Array<{ hay: boolean }> = await this.dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM "assistant_trace"
                       WHERE "trigger_message_id" = $1 AND "outcome" <> '${ResultadoDelAsistente.DISCARDED}') AS hay`,
      [triggerMessageId],
    );
    return fila?.hay ?? false;
  }

  /**
   * Consultas al modelo en la conversación (publicadas o descartadas): el
   * tope por conversación cuenta lo que se gastó, no sólo lo que se publicó.
   */
  private async consultasEnLaConversacion(
    conversationId: string,
  ): Promise<number> {
    const [fila]: Array<{ n: number }> = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM "assistant_trace"
        WHERE "conversation_id" = $1 AND "model" IS NOT NULL`,
      [conversationId],
    );
    return fila?.n ?? 0;
  }

  /**
   * Tokens del mes (calendario de Argentina), descartadas incluidas: los de
   * la empresa con sus clientes (C3) o los del soporte de la plataforma (C1,
   * de todas las empresas: lo paga la plataforma) y, aparte, los de la
   * empresa que pregunta en el soporte (su cupo).
   */
  private async tokensDelMes(
    c: Conversation,
    perfil: PerfilDelCanal,
  ): Promise<TokensDelMes> {
    const soporte = perfil.canal === 'soporte';
    const [fila]: Array<{ n: string | null; empresa: string | null }> =
      await this.dataSource.query(
        `SELECT sum("input_tokens" + "output_tokens" + "cache_read_tokens" + "cache_creation_tokens")::bigint AS n,
                sum("input_tokens" + "output_tokens" + "cache_read_tokens" + "cache_creation_tokens")
                  FILTER (WHERE "distributor_id" = $2)::bigint AS empresa
           FROM "assistant_trace"
          WHERE "channel" = $1 ${soporte ? '' : 'AND "distributor_id" = $2'}
            AND "created_at" >= (date_trunc('month', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                                 AT TIME ZONE 'America/Argentina/Buenos_Aires')`,
        [c.channel, c.distributorId],
      );
    return {
      total: Number(fila?.n ?? 0),
      deLaEmpresa: soporte ? Number(fila?.empresa ?? 0) : 0,
    };
  }

  /** Los últimos mensajes visibles con texto de ESA conversación, del más viejo al más nuevo. */
  private async hilo(conversationId: string): Promise<MensajeDelHilo[]> {
    const filas: Array<{
      sender_party: Party;
      kind: MessageKind;
      body: string;
    }> = await this.dataSource.query(
      `SELECT "sender_party", "kind", "body" FROM "message"
        WHERE "conversation_id" = $1 AND "visibility" = 'all'
          AND "kind" IN ('text', 'auto_reply') AND "body" IS NOT NULL
          AND "withdrawn_at" IS NULL AND "redacted_at" IS NULL AND "deleted_at" IS NULL
        ORDER BY "seq" DESC LIMIT $2`,
      [conversationId, MENSAJES_DE_CONTEXTO],
    );
    return filas.reverse().map((f) => ({
      senderParty: f.sender_party,
      kind: f.kind,
      body: f.body,
    }));
  }

  /**
   * Publica la respuesta o la derivación con su traza, en una transacción con
   * la conversación bloqueada y la regla vuelta a mirar: si mientras se
   * consultaba la cerraron, la tomó alguien, se retiró el mensaje o llegó
   * otro de la misma punta, no publica y la consulta queda como descartada.
   */
  private async publicar(
    c: Conversation,
    m: Message,
    perfil: PerfilDelCanal,
    atencion: Atencion,
    resultado: RespuestaDelModelo,
    inicio: number,
    ahora: Date,
  ): Promise<boolean> {
    const deriva = resultado.tipo === 'derivar';
    const efectos = new Efectos();
    let desenlace: Desenlace;
    try {
      desenlace = await this.dataSource.transaction(async (manager) => {
        const actual = await manager.getRepository(Conversation).findOne({
          where: {
            conversationId: c.conversationId,
            distributorId: c.distributorId,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!actual) {
          return { publicado: false, motivo: MotivoDeDescarte.CLOSED };
        }
        const motivo = await this.chat.motivoParaCallarse(
          manager,
          actual,
          m,
          ahora,
        );
        if (motivo) {
          return { publicado: false, motivo: motivo as MotivoDeDescarte };
        }
        const replyMessageId = deriva
          ? await this.derivar(
              manager,
              actual,
              perfil,
              atencion,
              resultado,
              efectos,
              ahora,
            )
          : await this.escribir(
              manager,
              actual,
              atencion,
              resultado.texto,
              {
                model: resultado.modelo,
              },
              PLANTILLA_DEL_ASISTENTE,
              efectos,
            );
        await manager.getRepository(AssistantTrace).insert({
          ...this.traza(c, m, resultado, inicio),
          replyMessageId,
          outcome: deriva
            ? ResultadoDelAsistente.HANDED_OFF
            : ResultadoDelAsistente.ANSWERED,
          reason: deriva ? resultado.motivo : null,
        });
        return { publicado: true, replyMessageId };
      });
    } catch (error) {
      if (error instanceof ConversacionCerradaError) {
        desenlace = { publicado: false, motivo: MotivoDeDescarte.CLOSED };
      } else if (codigoSqlDelError(error) === UNICO_VIOLADO) {
        desenlace = { publicado: false, motivo: MotivoDeDescarte.DUPLICATE };
      } else {
        throw error;
      }
    }
    // Lo consultado y no publicado igual se paga: queda en la traza y cuenta para los topes.
    if (!desenlace.publicado && resultado.modelo !== null) {
      await this.dataSource.getRepository(AssistantTrace).insert({
        ...this.traza(c, m, resultado, inicio),
        replyMessageId: null,
        outcome: ResultadoDelAsistente.DISCARDED,
        reason: desenlace.motivo,
      });
    }
    // La traza en el log, sin el texto de nadie ni la clave.
    const que = desenlace.publicado
      ? deriva
        ? `derivó motivo=${resultado.motivo}`
        : 'respondió'
      : `descartó motivo=${desenlace.motivo}`;
    this.logger.log(
      `asistente conversation=${c.conversationId} canal=${perfil.canal} ${que} ` +
        `tokens_entrada=${resultado.uso.inputTokens} tokens_salida=${resultado.uso.outputTokens} ` +
        `cache_leida=${resultado.uso.cacheReadTokens} cache_escrita=${resultado.uso.cacheCreationTokens} ` +
        `total=${tokensQueCuentan(resultado.uso)} latencia_ms=${Date.now() - inicio}`,
    );
    if (desenlace.publicado) this.eventos.publicar(efectos);
    return desenlace.publicado;
  }

  private traza(
    c: Conversation,
    m: Message,
    resultado: RespuestaDelModelo,
    inicio: number,
  ) {
    return {
      distributorId: c.distributorId,
      conversationId: c.conversationId,
      channel: c.channel,
      triggerMessageId: m.messageId,
      model: resultado.modelo,
      inputTokens: resultado.uso.inputTokens,
      outputTokens: resultado.uso.outputTokens,
      cacheReadTokens: resultado.uso.cacheReadTokens,
      cacheCreationTokens: resultado.uso.cacheCreationTokens,
      toolsUsed: resultado.herramientas,
      latencyMs: Math.max(0, Date.now() - inicio),
    };
  }

  /** Un mensaje del asistente con IA, firmado. Devuelve su id. */
  private async escribir(
    manager: EntityManager,
    c: Conversation,
    atencion: Atencion,
    body: string,
    ai: { model: string | null; handoff?: boolean },
    templateKey: string,
    efectos: Efectos,
  ): Promise<string> {
    const r = await this.writer.escribir(manager, {
      conversationId: c.conversationId,
      distributorId: c.distributorId,
      senderParty: Party.SYSTEM,
      senderUserId: null,
      clientMessageId: null,
      kind: MessageKind.AUTO_REPLY,
      visibility: MessageVisibility.ALL,
      body,
      payload: { senderLabel: atencion.senderLabel, ai },
      systemCode: null,
      templateKey,
    });
    efectos.mensaje(r.conversation, r.message);
    return r.message.messageId;
  }

  /**
   * Pasa la conversación a una persona: si la IA no corrió (tope o falla),
   * las respuestas fijas de siempre (o, si no corresponde ninguna, el aviso
   * de derivación); si la IA decidió derivar, el aviso de derivación. Queda
   * «esperando persona» y el equipo se entera por el aviso de la bandeja.
   */
  private async derivar(
    manager: EntityManager,
    c: Conversation,
    perfil: PerfilDelCanal,
    atencion: Atencion,
    resultado: Extract<RespuestaDelModelo, { tipo: 'derivar' }>,
    efectos: Efectos,
    ahora: Date,
  ): Promise<string | null> {
    let replyMessageId: string | null = null;
    if (DERIVACIONES_SIN_IA.has(resultado.motivo)) {
      const antes = efectos.mensajes.length;
      const escribio =
        perfil.canal === 'soporte'
          ? await this.fijas.delSoporte(manager, c, efectos, ahora)
          : await this.fijas.deLaEmpresa(manager, c, efectos, ahora);
      if (escribio) {
        replyMessageId = efectos.mensajes[antes]?.message.messageId ?? null;
      }
    }
    if (replyMessageId === null) {
      replyMessageId = await this.escribir(
        manager,
        c,
        atencion,
        await this.textoDeDerivacion(manager, c, atencion, ahora),
        { model: resultado.modelo, handoff: true },
        PLANTILLA_DE_DERIVACION,
        efectos,
      );
    }
    await manager.query(
      `UPDATE "conversation" SET "awaiting_human_since" = $2
        WHERE "conversation_id" = $1 AND "awaiting_human_since" IS NULL`,
      [c.conversationId, ahora],
    );
    c.awaitingHumanSince = ahora;
    efectos.conversacion(c, 'status');
    return replyMessageId;
  }

  /**
   * El texto de derivación (el de la empresa, con variables, o el de la
   * plataforma) y, fuera de horario, cuándo vuelve a atender el equipo.
   */
  private async textoDeDerivacion(
    manager: EntityManager,
    c: Conversation,
    atencion: Atencion,
    ahora: Date,
  ): Promise<string> {
    const quien = atencion.nombreDeQuienAtiende;
    if (!atencion.ajustes) {
      const s = atencion.soporte;
      const abre = estaAbierto(s.chatHours, s.timezone, ahora)
        ? null
        : proximaApertura(s.chatHours, s.timezone, ahora);
      const base = `Te paso con alguien del equipo de ${quien}. Te va a responder a la brevedad.`;
      return abre
        ? `Te paso con alguien del equipo de ${quien}. El equipo vuelve a atender ${textoDeLaProximaAtencion(abre, s.timezone, ahora)}.`
        : base;
    }
    const plantilla = textoDeDerivacion(atencion.ajustes);
    const fuera = !atiendeLaEmpresa(horarioDe(atencion.ajustes), ahora);
    const conHorario =
      fuera && !plantilla.includes('{{horario.proximo}}')
        ? `${plantilla} El equipo vuelve a atender {{horario.proximo}}.`
        : plantilla;
    const texto = completarPlantilla(
      conHorario,
      await valoresDePlantilla(manager, c, atencion.ajustes, ahora),
    ).trim();
    return texto.length > 0
      ? texto
      : `Te paso con alguien del equipo de ${quien}.`;
  }
}
