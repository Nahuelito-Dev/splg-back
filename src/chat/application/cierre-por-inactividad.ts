import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  PLANTILLA_DEL_ASISTENTE_IA,
  SystemCode,
} from '../domain/chat.enums';
import { atiendeLaEmpresa } from '../domain/horario-de-la-empresa';
import {
  decidirInactividad,
  type EstadoDeInactividad,
  textoDelAviso,
} from '../domain/inactividad';
import { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import { Conversation } from '../entities/conversation.entity';
import {
  BandejaGestionService,
  VERSION_DEL_ID_DEL_LOTE,
} from './bandeja-gestion.service';
import { ChatEvents, Efectos } from './chat.events';
import {
  CompanyChatSettingsService,
  horarioDe,
} from './company-chat-settings.service';
import { MessageWriter } from './message-writer';

/** Conversaciones que mira cada corrida como mucho (el resto, en la siguiente). */
export const TOPE_DE_CANDIDATAS = 200;

/*
 * Qué mensaje cuenta para saber de qué lado está la pelota: el último
 * visible de una persona (cliente, chofer o alguien del equipo, texto o
 * adjunto) o una respuesta del asistente con IA (`template_key` = `$2`). No
 * cuentan los avisos del sistema (recibido, cierre, el propio aviso, la
 * reapertura), la respuesta fuera de horario, las notas internas ni un
 * mensaje masivo a choferes (su `client_message_id` es un uuid de versión
 * `$5`, ver `idDelMensajeDelLote`). Las dos consultas lo repiten tal cual: no
 * se interpola nada en el SQL, los valores van por parámetro.
 */

/**
 * El último mensaje que cuenta de una conversación, su última reapertura y
 * su último aviso (con el cierre que mostró). `$1`: la conversación; `$2`: la
 * clave de las respuestas del asistente con IA; `$3`: el código de la
 * reapertura; `$4`: el del aviso; `$5`: la versión del id de los lotes.
 */
export const SQL_ESTADO_DE_INACTIVIDAD = `SELECT u."sender_party", u."created_at" AS ultimo_at,
       (SELECT max(r."created_at") FROM "message" r
         WHERE r."conversation_id" = $1 AND r."deleted_at" IS NULL
           AND r."system_code" = $3) AS reabierta_at,
       w."created_at" AS aviso_at, w."payload" ->> 'closesAt' AS aviso_cierra
  FROM (SELECT 1) base
  LEFT JOIN LATERAL (
    SELECT m."sender_party", m."created_at" FROM "message" m
     WHERE m."conversation_id" = $1
       AND m."deleted_at" IS NULL AND m."visibility" = 'all'
       AND ((m."sender_party" IN ('customer', 'driver', 'company')
              AND m."kind" IN ('text', 'attachment')
              AND NOT (m."sender_party" = 'company'
                       AND substring(m."client_message_id"::text from 15 for 1) = $5))
         OR (m."sender_party" = 'system' AND m."kind" = 'auto_reply'
              AND m."template_key" = $2))
     ORDER BY m."seq" DESC LIMIT 1) u ON TRUE
  LEFT JOIN LATERAL (
    SELECT a."created_at", a."payload" FROM "message" a
     WHERE a."conversation_id" = $1 AND a."deleted_at" IS NULL
       AND a."system_code" = $4
     ORDER BY a."seq" DESC LIMIT 1) w ON TRUE`;

export const parametrosDelEstado = (conversationId: string) => [
  conversationId,
  PLANTILLA_DEL_ASISTENTE_IA,
  SystemCode.REOPENED,
  SystemCode.INACTIVITY_WARNING,
  VERSION_DEL_ID_DEL_LOTE,
];

/**
 * Las conversaciones a las que ya les toca algo (avisar o cerrar), de las
 * empresas que hoy pueden (las calcula el servicio: cierre prendido, en
 * horario y con el módulo; los clientes, además, con su chat prendido). El
 * ciclo arranca en lo más tarde entre el último mensaje que cuenta, la
 * última reapertura y desde cuándo rigen los plazos; un aviso vale si es de
 * ese ciclo y nunca se cierra antes del cierre que mostró. Las que vencieron
 * antes van primero, hasta `$8`.
 *
 * `$1`: ahora; `$2`–`$5`: como en `SQL_ESTADO_DE_INACTIVIDAD`; `$6`: las
 * empresas para las conversaciones con clientes; `$7`: las de choferes.
 */
export const SQL_CANDIDATAS_POR_INACTIVIDAD = `SELECT x."id", x."empresa" FROM (
  SELECT c."conversation_id" AS "id", c."distributor_id" AS "empresa",
         s."inactivity_close_minutes" AS cierre, s."inactivity_warning_minutes" AS aviso,
         ini."inicio", w."cierra" AS aviso_cierra, w."at" AS aviso_at
    FROM "chat_company_settings" s
    JOIN "distributor" d ON d."distributor_id" = s."distributor_id" AND d."deletedAt" IS NULL
    JOIN "conversation" c ON c."distributor_id" = s."distributor_id"
    CROSS JOIN LATERAL (
      SELECT m."sender_party", m."created_at" FROM "message" m
       WHERE m."conversation_id" = c."conversation_id"
         AND m."distributor_id" = c."distributor_id"
         AND m."deleted_at" IS NULL AND m."visibility" = 'all'
         AND ((m."sender_party" IN ('customer', 'driver', 'company')
                AND m."kind" IN ('text', 'attachment')
                AND NOT (m."sender_party" = 'company'
                         AND substring(m."client_message_id"::text from 15 for 1) = $5))
           OR (m."sender_party" = 'system' AND m."kind" = 'auto_reply'
                AND m."template_key" = $2))
       ORDER BY m."seq" DESC LIMIT 1) u
    CROSS JOIN LATERAL (
      SELECT GREATEST(u."created_at", s."inactivity_enabled_at",
               (SELECT max(r."created_at") FROM "message" r
                 WHERE r."conversation_id" = c."conversation_id"
                   AND r."deleted_at" IS NULL AND r."system_code" = $3)) AS "inicio") ini
    LEFT JOIN LATERAL (
      SELECT a."created_at" AS "at", (a."payload" ->> 'closesAt')::timestamptz AS "cierra"
        FROM "message" a
       WHERE a."conversation_id" = c."conversation_id" AND a."deleted_at" IS NULL
         AND a."system_code" = $4 AND a."created_at" >= ini."inicio"
       ORDER BY a."seq" DESC LIMIT 1) w ON TRUE
   WHERE s."inactivity_close_minutes" IS NOT NULL
     AND ((c."channel" = 'staff_customer' AND c."distributor_id" = ANY($6::uuid[]))
       OR (c."channel" = 'staff_driver' AND c."distributor_id" = ANY($7::uuid[])))
     AND c."status" = 'open' AND c."deleted_at" IS NULL
     AND c."awaiting_human_since" IS NULL
     AND u."sender_party" IN ('company', 'system')) x
 CROSS JOIN LATERAL (
   SELECT CASE
            WHEN x.aviso IS NOT NULL AND x.aviso_at IS NULL
              THEN x."inicio" + make_interval(mins => x.cierre - x.aviso)
            ELSE GREATEST(x."inicio" + make_interval(mins => x.cierre),
                          COALESCE(x.aviso_cierra, x."inicio"))
          END AS "vence") v
 WHERE v."vence" <= $1::timestamptz
 ORDER BY v."vence", x."id"
 LIMIT $8`;

export type ResultadoDeInactividad = 'warned' | 'closed' | null;

/** Las empresas que hoy pueden avisar o cerrar, por canal. */
export interface EmpresasDelCierre {
  conClientes: string[];
  conChoferes: string[];
}

const fecha = (v: Date | string | null | undefined): Date | null =>
  v === null || v === undefined ? null : new Date(v);

function quien(party: Party | null): EstadoDeInactividad['ultimo'] {
  if (party === null) return null;
  if (party === Party.COMPANY) return 'team';
  if (party === Party.SYSTEM) return 'assistant';
  return 'person';
}

/**
 * Cierre por inactividad de la bandeja (C2/C3, tanda 7c). Lo corre la tarea
 * `chat_inactivity_close`: busca las candidatas de las empresas que hoy
 * pueden (cierre prendido, en su horario de atención y con el módulo `chat`;
 * con los clientes, además, su chat prendido) y decide cada una con la
 * conversación bloqueada, volviendo a mirar todo (si el cliente contestó
 * entre medio, no hace nada). Avisa con un mensaje de sistema
 * `inactivity_warning` y cierra con `closed_reason = 'inactivity'` por el
 * mismo camino que el cierre a mano (mensaje `closed_inactivity` y la
 * encuesta al cliente, 4b).
 */
@Injectable()
export class CierrePorInactividad {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ajustes: CompanyChatSettingsService,
    private readonly gestion: BandejaGestionService,
    private readonly writer: MessageWriter,
    private readonly eventos: ChatEvents,
  ) {}

  /** Las empresas con el cierre prendido que ahora pueden actuar. */
  async empresas(ahora: Date): Promise<EmpresasDelCierre> {
    const prendidas = await this.dataSource
      .getRepository(ChatCompanySettings)
      .find({ where: { inactivityCloseMinutes: Not(IsNull()) } });
    const r: EmpresasDelCierre = { conClientes: [], conChoferes: [] };
    for (const a of prendidas) {
      if (!atiendeLaEmpresa(horarioDe(a), ahora)) continue;
      if (!(await this.ajustes.chatDisponible(a.distributorId))) continue;
      r.conChoferes.push(a.distributorId);
      if (a.customerChatEnabled) r.conClientes.push(a.distributorId);
    }
    return r;
  }

  async candidatas(
    ahora: Date,
  ): Promise<Array<{ id: string; empresa: string }>> {
    const e = await this.empresas(ahora);
    if (e.conClientes.length === 0 && e.conChoferes.length === 0) return [];
    return this.dataSource.query(SQL_CANDIDATAS_POR_INACTIVIDAD, [
      ahora,
      PLANTILLA_DEL_ASISTENTE_IA,
      SystemCode.REOPENED,
      SystemCode.INACTIVITY_WARNING,
      VERSION_DEL_ID_DEL_LOTE,
      e.conClientes,
      e.conChoferes,
      TOPE_DE_CANDIDATAS,
    ]);
  }

  /** Avisa, cierra o nada, con la conversación bloqueada. */
  async procesar(
    conversationId: string,
    ahora: Date,
  ): Promise<ResultadoDeInactividad> {
    const efectos = new Efectos();
    const r = await this.dataSource.transaction(async (manager) => {
      const c = await manager.getRepository(Conversation).findOne({
        where: { conversationId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!c || c.status !== ConversationStatus.OPEN) return null;
      const a = await this.ajustes.leer(c.distributorId, manager);
      // Fuera de horario no se avisa ni se cierra (lo hace cuando abre); con
      // el módulo apagado o, con un cliente, con su chat apagado, tampoco.
      if (
        !atiendeLaEmpresa(horarioDe(a), ahora) ||
        (c.channel === Channel.STAFF_CUSTOMER && !a.customerChatEnabled) ||
        !(await this.ajustes.chatDisponible(c.distributorId))
      ) {
        return null;
      }
      const decision = decidirInactividad(
        await estadoDe(manager, c),
        {
          cerrarMinutos: a.inactivityCloseMinutes,
          avisarMinutos: a.inactivityWarningMinutes,
          habilitadoAt: a.inactivityEnabledAt,
        },
        ahora,
      );
      if (decision.accion === 'avisar') {
        const escrito = await this.writer.escribir(manager, {
          conversationId: c.conversationId,
          distributorId: c.distributorId,
          senderParty: Party.SYSTEM,
          senderUserId: null,
          clientMessageId: null,
          kind: MessageKind.SYSTEM,
          visibility: MessageVisibility.ALL,
          body: textoDelAviso(decision.minutos),
          payload: {
            minutes: decision.minutos,
            closesAt: decision.cierraAt.toISOString(),
          },
          systemCode: SystemCode.INACTIVITY_WARNING,
          templateKey: null,
        });
        efectos.mensaje(escrito.conversation, escrito.message);
        return 'warned' as const;
      }
      if (decision.accion === 'cerrar') {
        await this.gestion.cerrarDentro(
          manager,
          c,
          ConversationClosedReason.INACTIVITY,
          null,
          efectos,
          ahora,
        );
        return 'closed' as const;
      }
      return null;
    });
    this.eventos.publicar(efectos);
    return r;
  }
}

async function estadoDe(
  manager: EntityManager,
  c: Conversation,
): Promise<EstadoDeInactividad> {
  const [f]: Array<{
    sender_party: Party | null;
    ultimo_at: Date | string | null;
    reabierta_at: Date | string | null;
    aviso_at: Date | string | null;
    aviso_cierra: string | null;
  }> = await manager.query(
    SQL_ESTADO_DE_INACTIVIDAD,
    parametrosDelEstado(c.conversationId),
  );
  const avisoAt = fecha(f?.aviso_at);
  const cierra = fecha(f?.aviso_cierra);
  return {
    ultimo: quien(f?.sender_party ?? null),
    ultimoAt: fecha(f?.ultimo_at),
    reabiertaAt: fecha(f?.reabierta_at),
    // Un aviso sin el cierre que mostró no se puede respetar: no vale.
    aviso:
      avisoAt && cierra && !Number.isNaN(cierra.getTime())
        ? { at: avisoAt, cierraAt: cierra }
        : null,
    esperandoPersona: c.awaitingHumanSince !== null,
  };
}
