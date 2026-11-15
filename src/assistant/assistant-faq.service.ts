import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import {
  claveOcupada,
  conflictoDeLaBase,
  preguntaInexistente,
  preguntaRepetida,
  TOPE_DE_PREGUNTAS,
  topeAlcanzado,
} from './assistant.errors';
import { AssistantFaqTemplate } from './entities/assistant-faq-template.entity';
import { AssistantFaq } from './entities/assistant-faq.entity';
import { AssistantKnowledgeBase } from './entities/assistant-knowledge-base.entity';
import { assertTextoValido } from './texto-plano';

/**
 * De quién es la base: el id de la distribuidora, o `null` para la de la
 * plataforma (OrixTech). Sale siempre del contexto de la request (nunca de un
 * parámetro), así una empresa sólo ve y toca la suya.
 */
export type DuenioDeLaBase = string | null;

export interface DatosDePregunta {
  question: string;
  answer: string;
  /** Sólo la plataforma la elige; en una empresa la pone la copia de ejemplos. */
  key?: string;
}

export type CambiosDePregunta = Partial<
  Pick<DatosDePregunta, 'question' | 'answer'>
>;

export interface BaseDeConocimiento {
  items: AssistantFaq[];
  version: number;
}

export interface CopiaDePlantillas {
  copied: number;
  skipped: number;
  version: number;
}

interface BaseBloqueada {
  id: string;
  version: number;
}

/** La posición más alta de la base (0 si está vacía). */
const ultimaPosicion = (filas: ReadonlyArray<{ position: number }>): number =>
  filas.reduce((max, f) => Math.max(max, f.position), 0);

/** Igual que el único `UQ_assistant_faq_pregunta_vigente`: sin mayúsculas ni espacios de los bordes. */
export const normalizarPregunta = (texto: string): string =>
  texto.trim().toLowerCase();

/**
 * Las preguntas de ejemplo que la base todavía no tiene (por clave o por la
 * misma pregunta), en el orden del catálogo. Es la regla de la copia
 * (`from-templates`) y la que muestra `GET /company/assistant/templates`.
 */
export function ejemplosQueFaltan<
  T extends Pick<AssistantFaqTemplate, 'key' | 'question'>,
>(
  ejemplos: ReadonlyArray<T>,
  vigentes: ReadonlyArray<Pick<AssistantFaq, 'key' | 'question'>>,
): T[] {
  const claves = new Set(vigentes.map((v) => v.key));
  const preguntas = new Set(
    vigentes.map((v) => normalizarPregunta(v.question)),
  );
  return ejemplos.filter((e) => {
    const pregunta = normalizarPregunta(e.question);
    if (claves.has(e.key) || preguntas.has(pregunta)) return false;
    claves.add(e.key);
    preguntas.add(pregunta);
    return true;
  });
}

/**
 * Base de conocimiento del asistente del chat (DISENO-CH-BOT §4.3): preguntas
 * frecuentes de cada distribuidora y de la plataforma, con su versión.
 *
 * Toda escritura corre en una transacción que primero bloquea la cabecera de
 * la base (`FOR UPDATE`, la crea si no existía): las escrituras de una misma
 * base quedan en fila, así el tope de preguntas, las repetidas y la copia de
 * preguntas de ejemplo se controlan sin carreras. La versión sube en la misma
 * transacción que el cambio.
 */
@Injectable()
export class AssistantFaqService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Las vigentes de la base, en su orden, y su versión. Las dos lecturas van
   * en una transacción `REPEATABLE READ`: ven la misma foto de la base, así
   * la versión siempre es la de esa lista (B3 la usa como clave de caché).
   */
  listar(duenio: DuenioDeLaBase): Promise<BaseDeConocimiento> {
    const deQuien = { distributorId: duenio ?? IsNull() };
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const items = await manager.getRepository(AssistantFaq).find({
        where: deQuien,
        order: { position: 'ASC', createdAt: 'ASC' },
      });
      const base = await manager
        .getRepository(AssistantKnowledgeBase)
        .findOne({ where: deQuien });
      return { items, version: base?.version ?? 0 };
    });
  }

  async crear(
    duenio: DuenioDeLaBase,
    datos: DatosDePregunta,
    actorUserId: string | null,
  ): Promise<AssistantFaq> {
    assertTextoValido(datos);
    return this.escribir(async (manager) => {
      const base = await this.bloquearBase(manager, duenio);
      const vigentes = await this.vigentes(manager, base.id);
      if (vigentes.length >= TOPE_DE_PREGUNTAS) throw topeAlcanzado();
      const pregunta = normalizarPregunta(datos.question);
      if (vigentes.some((v) => normalizarPregunta(v.question) === pregunta)) {
        throw preguntaRepetida();
      }
      if (datos.key && vigentes.some((v) => v.key === datos.key)) {
        throw claveOcupada();
      }
      const repo = manager.getRepository(AssistantFaq);
      const fila = await repo.save(
        repo.create({
          knowledgeBaseId: base.id,
          distributorId: duenio,
          key: datos.key ?? null,
          question: datos.question,
          answer: datos.answer,
          position: ultimaPosicion(vigentes) + 1,
          createdBy: actorUserId,
          updatedBy: actorUserId,
        }),
      );
      await this.subirVersion(manager, base, actorUserId);
      return fila;
    });
  }

  /** Edita lo que viene. Si no cambia nada no escribe ni sube la versión. */
  async actualizar(
    duenio: DuenioDeLaBase,
    faqId: string,
    cambios: CambiosDePregunta,
    actorUserId: string | null,
  ): Promise<AssistantFaq> {
    assertTextoValido(cambios);
    return this.escribir(async (manager) => {
      const base = await this.bloquearBase(manager, duenio);
      const fila = await this.buscar(manager, base.id, duenio, faqId);
      const nuevos = {
        question: cambios.question ?? fila.question,
        answer: cambios.answer ?? fila.answer,
      };
      const cambia =
        nuevos.question !== fila.question || nuevos.answer !== fila.answer;
      if (!cambia) return fila;
      if (
        normalizarPregunta(nuevos.question) !==
        normalizarPregunta(fila.question)
      ) {
        const pregunta = normalizarPregunta(nuevos.question);
        const vigentes = await this.vigentes(manager, base.id);
        const repetida = vigentes.some(
          (v) =>
            v.faqId !== fila.faqId &&
            normalizarPregunta(v.question) === pregunta,
        );
        if (repetida) throw preguntaRepetida();
      }
      Object.assign(fila, nuevos, { updatedBy: actorUserId });
      const guardada = await manager.getRepository(AssistantFaq).save(fila);
      await this.subirVersion(manager, base, actorUserId);
      return guardada;
    });
  }

  /** Baja lógica: deja de usarse, la fila y su historia quedan. */
  async darDeBaja(
    duenio: DuenioDeLaBase,
    faqId: string,
    actorUserId: string | null,
  ): Promise<void> {
    await this.escribir(async (manager) => {
      const base = await this.bloquearBase(manager, duenio);
      const fila = await this.buscar(manager, base.id, duenio, faqId);
      await manager.query(
        `UPDATE "assistant_faq"
            SET "deleted_at" = now(), "updated_at" = now(), "updated_by" = $2
          WHERE "faq_id" = $1 AND "deleted_at" IS NULL`,
        [fila.faqId, actorUserId],
      );
      await this.subirVersion(manager, base, actorUserId);
    });
  }

  /**
   * Copia a la base de la distribuidora las preguntas de ejemplo vigentes del
   * catálogo (D-B7) que todavía no tiene (por clave o por la misma pregunta).
   * Nunca lee la base de OrixTech (D-B6). Idempotente: la segunda vez no
   * copia nada ni sube la versión. Todo o nada: si no entran todas bajo el
   * tope, no copia ninguna. Las copias son de la distribuidora: no quedan
   * atadas al catálogo.
   */
  async copiarPlantillas(
    distributorId: string,
    actorUserId: string | null,
  ): Promise<CopiaDePlantillas> {
    return this.escribir(async (manager) => {
      const base = await this.bloquearBase(manager, distributorId);
      const vigentes = await this.vigentes(manager, base.id);
      const ejemplos = await manager.getRepository(AssistantFaqTemplate).find({
        order: { position: 'ASC', createdAt: 'ASC' },
      });
      const nuevas = ejemplosQueFaltan(ejemplos, vigentes);
      const sobran = vigentes.length + nuevas.length - TOPE_DE_PREGUNTAS;
      if (sobran > 0) throw topeAlcanzado(sobran);
      if (nuevas.length === 0) {
        return {
          copied: 0,
          skipped: ejemplos.length,
          version: base.version,
        };
      }
      // Van al final de la base, en el orden del catálogo.
      const desde = ultimaPosicion(vigentes);
      const repo = manager.getRepository(AssistantFaq);
      await repo.save(
        nuevas.map((e, i) =>
          repo.create({
            position: desde + i + 1,
            knowledgeBaseId: base.id,
            distributorId,
            key: e.key,
            question: e.question,
            answer: e.answer,
            createdBy: actorUserId,
            updatedBy: actorUserId,
          }),
        ),
      );
      return {
        copied: nuevas.length,
        skipped: ejemplos.length - nuevas.length,
        version: await this.subirVersion(manager, base, actorUserId),
      };
    });
  }

  /** Corre la escritura en una transacción y da su `code` a los únicos de la base. */
  private async escribir<T>(
    trabajo: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(trabajo);
    } catch (error) {
      throw conflictoDeLaBase(error) ?? error;
    }
  }

  /**
   * Bloquea la cabecera de la base hasta el fin de la transacción; la crea
   * la primera vez (una carrera en el alta la resuelve el único: `DO NOTHING`
   * y las dos leen la misma fila).
   */
  private async bloquearBase(
    manager: EntityManager,
    duenio: DuenioDeLaBase,
  ): Promise<BaseBloqueada> {
    await manager.query(
      `INSERT INTO "assistant_knowledge_base" ("distributor_id") VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [duenio],
    );
    const filas = await manager.query<Array<{ id: string; version: number }>>(
      duenio === null
        ? `SELECT "knowledge_base_id" AS "id", "version" FROM "assistant_knowledge_base"
            WHERE "distributor_id" IS NULL FOR UPDATE`
        : `SELECT "knowledge_base_id" AS "id", "version" FROM "assistant_knowledge_base"
            WHERE "distributor_id" = $1 FOR UPDATE`,
      duenio === null ? [] : [duenio],
    );
    return { id: filas[0].id, version: Number(filas[0].version) };
  }

  /**
   * Sube la versión de la base y devuelve la nueva. La base está bloqueada
   * desde `bloquearBase`: nadie más la cambió en el medio.
   */
  private async subirVersion(
    manager: EntityManager,
    base: BaseBloqueada,
    actorUserId: string | null,
  ): Promise<number> {
    await manager.query(
      `UPDATE "assistant_knowledge_base"
          SET "version" = "version" + 1, "updated_at" = now(), "updated_by" = $2
        WHERE "knowledge_base_id" = $1`,
      [base.id, actorUserId],
    );
    return base.version + 1;
  }

  private vigentes(
    manager: EntityManager,
    baseId: string,
  ): Promise<
    Array<Pick<AssistantFaq, 'faqId' | 'key' | 'question' | 'position'>>
  > {
    return manager.getRepository(AssistantFaq).find({
      select: { faqId: true, key: true, question: true, position: true },
      where: { knowledgeBaseId: baseId },
    });
  }

  /** La vigente de esta base; lo de otra base (otra empresa, la plataforma) es 404. */
  private async buscar(
    manager: EntityManager,
    baseId: string,
    duenio: DuenioDeLaBase,
    faqId: string,
  ): Promise<AssistantFaq> {
    const fila = await manager.getRepository(AssistantFaq).findOne({
      where: {
        faqId,
        knowledgeBaseId: baseId,
        distributorId: duenio ?? IsNull(),
      },
    });
    if (!fila) throw preguntaInexistente();
    return fila;
  }
}
