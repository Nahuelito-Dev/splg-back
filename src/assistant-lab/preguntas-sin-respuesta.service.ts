import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  MotivoDeDerivacion,
  ResultadoDelAsistente,
} from '../assistant-ai/asistente-ia.dominio';
import {
  AssistantFaqService,
  type DuenioDeLaBase,
} from '../assistant/assistant-faq.service';
import type { AssistantFaq } from '../assistant/entities/assistant-faq.entity';
import { Channel } from '../chat/domain/chat.enums';
import { periodoDeLasMetricas } from '../chat/domain/metricas';
import { PERIODO_MAXIMO_DIAS } from '../platform/application/periodo';
import {
  agruparSinRespuesta,
  CAUSAS_SIN_RESPUESTA,
  claveDelBorrador,
  type GrupoSinRespuesta,
  ID_DE_GRUPO,
  idDeLaPregunta,
  idsDeLosGrupos,
  type MensajeSinRespuesta,
  MOTIVOS_SIN_RESPUESTA,
  TOPE_DE_GRUPOS,
  TOPE_DE_MENSAJES_SIN_RESPUESTA,
  VUELTAS_PARA_BUSCAR_UN_GRUPO,
} from './assistant-lab.dominio';
import { grupoInexistente, idDeGrupoInvalido } from './assistant-lab.errors';
import type { EstadoDelGrupo } from './entities/assistant-unanswered-resolution.entity';

export interface PreguntasSinRespuesta {
  from: string;
  to: string;
  items: GrupoSinRespuesta[];
  /** Se miraron sólo los mensajes más nuevos del período (hay más). */
  truncated: boolean;
}

/** Lo que devuelve crear la pregunta: la nueva o la que ya se había creado para el grupo. */
export interface PreguntaDelGrupo {
  faq: AssistantFaq;
  creada: boolean;
}

/** El uuid «nulo» con que el único de las resoluciones iguala las de la plataforma. */
const SIN_EMPRESA = '00000000-0000-0000-0000-000000000000';

interface FilaSinRespuesta {
  trace_id: string;
  body: string;
  created_at: Date;
}

/** Desde dónde sigue una búsqueda por páginas (la última fila vista). */
interface Cursor {
  createdAt: Date;
  traceId: string;
}

/**
 * Preguntas que el asistente no supo contestar en conversaciones reales
 * (7b), agrupadas por texto parecido. Salen de las trazas (`assistant_trace`)
 * y del texto del mensaje que las disparó (si no se retiró ni se anonimizó).
 * «No supo»: derivó con el modelo corriendo por un motivo técnico
 * (`MOTIVOS_SIN_RESPUESTA`) o porque el modelo dijo que no tenía la
 * información o no estaba seguro (`requested` con causa
 * `CAUSAS_SIN_RESPUESTA`). Cada dueño ve sólo lo suyo: la empresa, lo que
 * preguntaron SUS clientes (C3, su `distributor_id`); la plataforma, lo que
 * le preguntaron las empresas en su soporte (C1). Nunca lo de una empresa en
 * otra, ni lo de C3 en la plataforma.
 */
@Injectable()
export class PreguntasSinRespuestaService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly preguntas: AssistantFaqService,
  ) {}

  async listar(
    duenio: DuenioDeLaBase,
    from: string | undefined,
    to: string | undefined,
    ahora: Date = new Date(),
  ): Promise<PreguntasSinRespuesta> {
    const periodo = periodoDeLasMetricas(from, to, ahora);
    const filas = await this.mensajes(
      duenio,
      periodo.desde,
      periodo.hasta,
      null,
    );
    const mensajes = filas.map(aMensaje);
    const resueltos = await this.resoluciones(duenio, idsDeLosGrupos(mensajes));
    return {
      from: periodo.from,
      to: periodo.to,
      items: agruparSinRespuesta(mensajes, resueltos).slice(0, TOPE_DE_GRUPOS),
      truncated: filas.length >= TOPE_DE_MENSAJES_SIN_RESPUESTA,
    };
  }

  /**
   * Crea una pregunta frecuente en borrador con la pregunta que confirmó o
   * editó la persona (nunca se copia sola la del cliente) en la base del
   * dueño y marca el grupo como resuelto, en una transacción. Si el grupo ya
   * tenía su pregunta creada y sigue vigente (el grupo volvió porque se
   * preguntó de nuevo), devuelve esa y vuelve a marcar el grupo resuelto.
   */
  async crearPregunta(
    duenio: DuenioDeLaBase,
    id: string,
    question: string,
    actorUserId: string | null,
    ahora: Date = new Date(),
  ): Promise<PreguntaDelGrupo> {
    await this.asegurarPendiente(duenio, id, ahora);
    const anterior = await this.faqDelGrupo(duenio, id);
    if (anterior) {
      await this.dataSource.transaction((manager) =>
        this.resolver(
          manager,
          duenio,
          id,
          'resolved',
          anterior.faqId,
          actorUserId,
        ),
      );
      return { faq: anterior, creada: false };
    }
    const faq = await this.preguntas.crearBorrador(
      duenio,
      {
        question,
        ...(duenio === null ? { key: claveDelBorrador(id) } : {}),
      },
      actorUserId,
      (manager, fila) =>
        this.resolver(manager, duenio, id, 'resolved', fila.faqId, actorUserId),
    );
    return { faq, creada: true };
  }

  /** No se muestra más lo que hay hasta ahora en el grupo (lo nuevo, sí). */
  async descartar(
    duenio: DuenioDeLaBase,
    id: string,
    actorUserId: string | null,
    ahora: Date = new Date(),
  ): Promise<void> {
    await this.asegurarPendiente(duenio, id, ahora);
    await this.dataSource.transaction((manager) =>
      this.resolver(manager, duenio, id, 'dismissed', null, actorUserId),
    );
  }

  /**
   * 404 si el grupo no tiene nada pendiente en el último año. Recorre los
   * mensajes por páginas, del más nuevo al más viejo, hasta encontrar uno del
   * grupo posterior a su resolución (no se limita a los 2.000 más nuevos);
   * corta al llegar a la fecha de la resolución, sin más páginas o al tope
   * de vueltas.
   */
  private async asegurarPendiente(
    duenio: DuenioDeLaBase,
    id: string,
    ahora: Date,
  ): Promise<void> {
    if (!ID_DE_GRUPO.test(id)) throw idDeGrupoInvalido();
    const resuelto = (await this.resoluciones(duenio, [id])).get(id) ?? null;
    const desde = new Date(ahora.getTime() - PERIODO_MAXIMO_DIAS * 86_400_000);
    let cursor: Cursor | null = null;
    for (let vuelta = 0; vuelta < VUELTAS_PARA_BUSCAR_UN_GRUPO; vuelta += 1) {
      const filas = await this.mensajes(
        duenio,
        resuelto && resuelto > desde ? resuelto : desde,
        ahora,
        cursor,
      );
      for (const f of filas) {
        const fecha = new Date(f.created_at);
        if (resuelto && fecha <= resuelto) break;
        if (idDeLaPregunta(f.body) === id) return;
      }
      if (filas.length < TOPE_DE_MENSAJES_SIN_RESPUESTA) break;
      const ultima = filas[filas.length - 1];
      cursor = {
        createdAt: new Date(ultima.created_at),
        traceId: ultima.trace_id,
      };
    }
    throw grupoInexistente();
  }

  /** La pregunta que se creó para el grupo, si sigue vigente en la base del dueño. */
  private async faqDelGrupo(
    duenio: DuenioDeLaBase,
    id: string,
  ): Promise<AssistantFaq | null> {
    const [fila]: Array<{ faq_id: string | null }> =
      await this.dataSource.query(
        `SELECT "faq_id" FROM "assistant_unanswered_resolution"
          WHERE "channel" = $1 AND ${duenio === null ? '"distributor_id" IS NULL' : '"distributor_id" = $3'}
            AND "question_key" = $2 AND "status" = 'resolved'`,
        [canalDe(duenio), id, ...(duenio === null ? [] : [duenio])],
      );
    return fila?.faq_id ? this.preguntas.vigente(duenio, fila.faq_id) : null;
  }

  /** Una página de mensajes que no supo contestar, del más nuevo al más viejo. */
  private mensajes(
    duenio: DuenioDeLaBase,
    desde: Date,
    hasta: Date,
    cursor: Cursor | null,
  ): Promise<FilaSinRespuesta[]> {
    return this.dataSource.query(
      `SELECT t."trace_id", m."body", t."created_at"
         FROM "assistant_trace" t
         JOIN "message" m ON m."message_id" = t."trigger_message_id"
                         AND m."distributor_id" = t."distributor_id"
        WHERE t."channel" = $1 ${duenio === null ? 'AND $5::uuid IS NULL' : 'AND t."distributor_id" = $5'}
          AND t."outcome" = '${ResultadoDelAsistente.HANDED_OFF}' AND t."model" IS NOT NULL
          AND (t."reason" = ANY($2::varchar[])
               OR (t."reason" = '${MotivoDeDerivacion.REQUESTED}'
                   AND t."handoff_cause" = ANY($6::varchar[])))
          AND t."created_at" >= $3 AND t."created_at" < $4
          AND ($7::timestamptz IS NULL OR (t."created_at", t."trace_id") < ($7::timestamptz, $8::uuid))
          AND m."body" IS NOT NULL AND m."withdrawn_at" IS NULL
          AND m."redacted_at" IS NULL AND m."deleted_at" IS NULL
        ORDER BY t."created_at" DESC, t."trace_id" DESC
        LIMIT ${TOPE_DE_MENSAJES_SIN_RESPUESTA}`,
      [
        canalDe(duenio),
        MOTIVOS_SIN_RESPUESTA,
        desde,
        hasta,
        duenio,
        CAUSAS_SIN_RESPUESTA,
        cursor?.createdAt ?? null,
        cursor?.traceId ?? null,
      ],
    );
  }

  /** Desde cuándo está resuelto o descartado cada grupo (id → cuándo). */
  private async resoluciones(
    duenio: DuenioDeLaBase,
    ids: string[],
  ): Promise<Map<string, Date>> {
    const resueltos = new Map<string, Date>();
    if (ids.length === 0) return resueltos;
    const filas: Array<{ question_key: string; resolved_at: Date }> =
      await this.dataSource.query(
        `SELECT "question_key", "resolved_at" FROM "assistant_unanswered_resolution"
          WHERE "channel" = $1 AND ${duenio === null ? '"distributor_id" IS NULL' : '"distributor_id" = $3'}
            AND "question_key" = ANY($2::varchar[])`,
        [canalDe(duenio), ids, ...(duenio === null ? [] : [duenio])],
      );
    for (const r of filas) {
      resueltos.set(r.question_key, new Date(r.resolved_at));
    }
    return resueltos;
  }

  /**
   * Marca el grupo (una fila por grupo y dueño; si ya estaba, se pisa: lo
   * anterior a ahora deja de mostrarse).
   */
  private async resolver(
    manager: EntityManager,
    duenio: DuenioDeLaBase,
    id: string,
    status: EstadoDelGrupo,
    faqId: string | null,
    actorUserId: string | null,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "assistant_unanswered_resolution"
              ("distributor_id", "channel", "question_key", "status", "faq_id", "resolved_by", "resolved_at")
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT ("channel", COALESCE("distributor_id", '${SIN_EMPRESA}'::uuid), "question_key")
       DO UPDATE SET "status" = EXCLUDED."status", "faq_id" = EXCLUDED."faq_id",
                     "resolved_by" = EXCLUDED."resolved_by", "resolved_at" = EXCLUDED."resolved_at",
                     "updated_at" = now()`,
      [duenio, canalDe(duenio), id, status, faqId, actorUserId],
    );
  }
}

const canalDe = (duenio: DuenioDeLaBase): Channel =>
  duenio === null ? Channel.PLATFORM_CHAT : Channel.STAFF_CUSTOMER;

const aMensaje = (f: FilaSinRespuesta): MensajeSinRespuesta => ({
  body: f.body,
  createdAt: new Date(f.created_at),
});
