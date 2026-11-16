import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  claveDeEjemploOcupada,
  conflictoDelCatalogo,
  ejemploInexistente,
  ejemploRepetido,
  TOPE_DE_PREGUNTAS,
  topeDelCatalogo,
} from './assistant.errors';
import { ejemplosQueFaltan, normalizarPregunta } from './assistant-faq.service';
import { AssistantFaqTemplate } from './entities/assistant-faq-template.entity';
import { AssistantFaq } from './entities/assistant-faq.entity';
import { assertClaveValida, assertTextoValido } from './texto-plano';

export interface DatosDeEjemplo {
  key: string;
  question: string;
  answer: string;
}

export type CambiosDeEjemplo = Partial<
  Pick<DatosDeEjemplo, 'question' | 'answer'>
>;

/** Una pregunta de ejemplo y si la base de la distribuidora ya la tiene. */
export interface EjemploParaLaEmpresa {
  ejemplo: AssistantFaqTemplate;
  yaEnLaBase: boolean;
}

/**
 * Clave del cerrojo de transacción (`pg_advisory_xact_lock`) que pone en
 * fila las escrituras del catálogo.
 */
export const CERROJO_DEL_CATALOGO = 'assistant_faq_template';

/**
 * Catálogo de preguntas de ejemplo para distribuidoras (DISENO-CH-BOT D-B7):
 * lo administra OrixTech y cada distribuidora lo copia a su base
 * (`AssistantFaqService.copiarPlantillas`).
 *
 * Concurrencia: el catálogo es uno solo y no tiene una fila cabecera que
 * bloquear (la cabecera de la base de OrixTech es de otra base, D-B6). Toda
 * escritura toma primero un cerrojo de transacción por clave
 * (`pg_advisory_xact_lock`, el mismo patrón que la bandeja y los roles): las
 * escrituras quedan en fila, así el tope, las repetidas y la posición se
 * controlan sin carreras; se suelta solo al terminar la transacción. Las
 * lecturas no lo toman. Si algo se escapa igual, los únicos parciales de la
 * base responden 409 con su `code`.
 */
@Injectable()
export class AssistantFaqTemplateService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Las vigentes, en el orden del catálogo. */
  listar(): Promise<AssistantFaqTemplate[]> {
    return this.dataSource.getRepository(AssistantFaqTemplate).find({
      order: { position: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * El catálogo como lo ve una distribuidora: cada pregunta con si su base
   * ya la tiene (misma regla que la copia). Las dos lecturas en una misma
   * foto (`REPEATABLE READ`). Leer no crea la base.
   */
  listarParaEmpresa(distributorId: string): Promise<EjemploParaLaEmpresa[]> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const ejemplos = await manager
        .getRepository(AssistantFaqTemplate)
        .find({ order: { position: 'ASC', createdAt: 'ASC' } });
      const vigentes = await manager.getRepository(AssistantFaq).find({
        select: { key: true, question: true },
        where: { distributorId },
      });
      const faltan = new Set(ejemplosQueFaltan(ejemplos, vigentes));
      return ejemplos.map((ejemplo) => ({
        ejemplo,
        yaEnLaBase: !faltan.has(ejemplo),
      }));
    });
  }

  async crear(
    datos: DatosDeEjemplo,
    actorUserId: string | null,
  ): Promise<AssistantFaqTemplate> {
    assertClaveValida(datos.key);
    assertTextoValido(datos);
    return this.escribir(async (manager) => {
      const vigentes = await this.vigentes(manager);
      if (vigentes.length >= TOPE_DE_PREGUNTAS) throw topeDelCatalogo();
      const pregunta = normalizarPregunta(datos.question);
      if (vigentes.some((v) => normalizarPregunta(v.question) === pregunta)) {
        throw ejemploRepetido();
      }
      if (vigentes.some((v) => v.key === datos.key)) {
        throw claveDeEjemploOcupada();
      }
      const repo = manager.getRepository(AssistantFaqTemplate);
      return repo.save(
        repo.create({
          key: datos.key,
          question: datos.question,
          answer: datos.answer,
          position:
            vigentes.reduce((max, v) => Math.max(max, v.position), 0) + 1,
          updatedBy: actorUserId,
        }),
      );
    });
  }

  /**
   * Edita lo que viene. Si no cambia nada no escribe. Lo ya copiado a las
   * distribuidoras no se toca: cada una ajusta la suya.
   */
  async actualizar(
    templateId: string,
    cambios: CambiosDeEjemplo,
    actorUserId: string | null,
  ): Promise<AssistantFaqTemplate> {
    assertTextoValido(cambios);
    return this.escribir(async (manager) => {
      const fila = await this.buscar(manager, templateId);
      const nuevos = {
        question: cambios.question ?? fila.question,
        answer: cambios.answer ?? fila.answer,
      };
      if (nuevos.question === fila.question && nuevos.answer === fila.answer) {
        return fila;
      }
      const pregunta = normalizarPregunta(nuevos.question);
      if (pregunta !== normalizarPregunta(fila.question)) {
        const vigentes = await this.vigentes(manager);
        const repetida = vigentes.some(
          (v) =>
            v.templateId !== fila.templateId &&
            normalizarPregunta(v.question) === pregunta,
        );
        if (repetida) throw ejemploRepetido();
      }
      Object.assign(fila, nuevos, { updatedBy: actorUserId });
      return manager.getRepository(AssistantFaqTemplate).save(fila);
    });
  }

  /**
   * Baja lógica: deja de ofrecerse; la clave, la pregunta y la posición
   * quedan libres. Lo ya copiado a las distribuidoras sigue.
   */
  async darDeBaja(
    templateId: string,
    actorUserId: string | null,
  ): Promise<void> {
    await this.escribir(async (manager) => {
      const fila = await this.buscar(manager, templateId);
      await manager.query(
        `UPDATE "assistant_faq_template"
            SET "deleted_at" = now(), "updated_at" = now(), "updated_by" = $2
          WHERE "template_id" = $1 AND "deleted_at" IS NULL`,
        [fila.templateId, actorUserId],
      );
    });
  }

  /**
   * Corre la escritura en una transacción con el catálogo en fila y da su
   * `code` a los únicos de la base.
   */
  private async escribir<T>(
    trabajo: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          CERROJO_DEL_CATALOGO,
        ]);
        return trabajo(manager);
      });
    } catch (error) {
      throw conflictoDelCatalogo(error) ?? error;
    }
  }

  private vigentes(
    manager: EntityManager,
  ): Promise<
    Array<
      Pick<AssistantFaqTemplate, 'templateId' | 'key' | 'question' | 'position'>
    >
  > {
    return manager.getRepository(AssistantFaqTemplate).find({
      select: { templateId: true, key: true, question: true, position: true },
    });
  }

  /** La vigente; una dada de baja o que no existe es 404. */
  private async buscar(
    manager: EntityManager,
    templateId: string,
  ): Promise<AssistantFaqTemplate> {
    const fila = await manager
      .getRepository(AssistantFaqTemplate)
      .findOne({ where: { templateId } });
    if (!fila) throw ejemploInexistente();
    return fila;
  }
}
