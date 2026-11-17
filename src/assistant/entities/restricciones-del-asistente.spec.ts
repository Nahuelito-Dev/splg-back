import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';
import { BaseDeConocimientoDelAsistente1795000000110 } from '../../migrations/1795000000110-BaseDeConocimientoDelAsistente';
import mapaGuardado from '../../audit/data/auditoria-mapa.datos.json';
import {
  CatalogoDePreguntasDeEjemplo1795000000112,
  MAPA_DEL_CATALOGO,
} from '../../migrations/1795000000112-CatalogoDePreguntasDeEjemplo';
import { ProbadorDelAsistente1795000000136 } from '../../migrations/1795000000136-ProbadorDelAsistente';
import { CLAVE, CLAVE_EN_LA_BASE, HTML, HTML_EN_LA_BASE } from '../texto-plano';
import { AssistantFaqTemplate } from './assistant-faq-template.entity';
import { AssistantFaq } from './assistant-faq.entity';
import { AssistantKnowledgeBase } from './assistant-knowledge-base.entity';

type Corridas = Array<[string, unknown[] | undefined]>;

/** Las sentencias que corre una migración, sin base. */
async function sentenciasDe(
  correr: (runner: QueryRunner) => Promise<void>,
): Promise<Corridas> {
  const corridas: Corridas = [];
  const runner = {
    query: (sql: string, params?: unknown[]) => {
      corridas.push([sql, params]);
      return Promise.resolve([{ id: 'base-plataforma' }]);
    },
  } as unknown as QueryRunner;
  await correr(runner);
  return corridas;
}

const sentencias = () =>
  sentenciasDe((r) => new BaseDeConocimientoDelAsistente1795000000110().up(r));
const subida112 = () =>
  sentenciasDe((r) => new CatalogoDePreguntasDeEjemplo1795000000112().up(r));
const subida136 = () =>
  sentenciasDe((r) => new ProbadorDelAsistente1795000000136().up(r));
const bajada112 = () =>
  sentenciasDe((r) => new CatalogoDePreguntasDeEjemplo1795000000112().down(r));

/** Los CHECK que crea un `CREATE TABLE`, por nombre. */
const checksDe = (crear: string | undefined): string[] =>
  [...(crear ?? '').matchAll(/CONSTRAINT "(CHK_[A-Za-z0-9_]+)" CHECK/g)].map(
    (m) => m[1],
  );

const checksDeLaEntidad = (entidad: object) =>
  getMetadataArgsStorage().checks.filter((c) => c.target === entidad);

describe('restricciones de la base de conocimiento (migraciones 110, 112 y 136, y entidades)', () => {
  it('las migraciones dejan exactamente los CHECK que declaran las entidades', async () => {
    const sql = [...(await sentencias()), ...(await subida112())].map(
      ([s]) => s,
    );
    // La 136 rehace la de la respuesta (borradores): manda la suya.
    const rehechos = new Map(
      (await subida136()).flatMap(([s]) =>
        [
          ...s.matchAll(
            /ADD CONSTRAINT "(CHK_assistant_faq_[A-Za-z0-9_]+)" CHECK \((.*)\)$/g,
          ),
        ].map((m) => [m[1], m[2]] as const),
      ),
    );
    expect([...rehechos.keys()]).toEqual(['CHK_assistant_faq_respuesta']);
    // Sólo lo que la 112 quita de las tablas del asistente (la 110 rehace otros CHECK de módulos).
    const quitados = (await subida112()).flatMap(([s]) =>
      [...s.matchAll(/DROP CONSTRAINT "(CHK_[A-Za-z0-9_]+)"/g)].map(
        (m) => m[1],
      ),
    );
    expect(quitados).toEqual(['CHK_assistant_faq_plantilla']);
    for (const [entidad, tabla] of [
      [AssistantFaq, 'assistant_faq'],
      [AssistantKnowledgeBase, 'assistant_knowledge_base'],
      [AssistantFaqTemplate, 'assistant_faq_template'],
    ] as const) {
      const crear = sql.find((s) => s.startsWith(`CREATE TABLE "${tabla}"`));
      const checks = checksDeLaEntidad(entidad);
      expect(checks.length).toBeGreaterThan(0);
      for (const c of checks) {
        const rehecho = rehechos.get(c.name ?? '');
        expect(
          rehecho ??
            crear?.includes(`CONSTRAINT "${c.name}" CHECK (${c.expression})`),
        ).toBe(rehecho === undefined ? true : c.expression);
      }
      expect(
        checksDe(crear)
          .filter((n) => !quitados.includes(n))
          .sort(),
      ).toEqual(checks.map((c) => c.name).sort());
    }
  });

  it('el catálogo tiene las mismas reglas de texto que la base y la clave obligatoria con el mismo formato', () => {
    const expresion = (entidad: object, sufijo: string) =>
      checksDeLaEntidad(entidad).find((c) => c.name?.endsWith(sufijo))
        ?.expression;
    for (const sufijo of ['_pregunta', '_sin_html', '_posicion']) {
      expect(expresion(AssistantFaqTemplate, sufijo)).toBe(
        expresion(AssistantFaq, sufijo),
      );
    }
    // La base admite borradores (respuesta vacía); el catálogo, no.
    expect(expresion(AssistantFaqTemplate, '_respuesta')).toBe(
      `char_length(btrim("answer")) BETWEEN 1 AND 1500`,
    );
    expect(expresion(AssistantFaq, '_respuesta')).toBe(
      `char_length(btrim("answer")) <= 1500`,
    );
    expect(expresion(AssistantFaqTemplate, '_clave')).toBe(
      `"key" ~ '${CLAVE_EN_LA_BASE}'`,
    );
    expect(expresion(AssistantFaq, '_clave')).toContain(CLAVE_EN_LA_BASE);
    expect(CLAVE.source).toBe(CLAVE_EN_LA_BASE);
  });

  it('el CHECK sin HTML usa el mismo patrón que el DTO y el servicio, y rechaza entidades sin punto y coma', async () => {
    const crear = (await sentencias())
      .map(([s]) => s)
      .find((s) => s.startsWith('CREATE TABLE "assistant_faq"'));
    expect(crear).toContain(`"answer" !~ '${HTML_EN_LA_BASE.entidad}'`);
    expect(crear).toContain(`"question" !~ '${HTML_EN_LA_BASE.etiqueta}'`);
    expect(`${HTML_EN_LA_BASE.etiqueta}|${HTML_EN_LA_BASE.entidad}`).toBe(
      HTML.source,
    );
    const enLaBase = new RegExp(HTML_EN_LA_BASE.entidad);
    for (const entidad of ['&amp;', '&amp', '&lt', '&#60', '&#x3C;']) {
      expect(enLaBase.test(`Sí ${entidad} no`)).toBe(true);
    }
    expect(enLaBase.test('De 3 & de 4 kg')).toBe(false);
  });

  it('las plantillas sembradas cumplen las reglas y llevan su orden 1..n', async () => {
    const plantillas = (await sentencias()).filter(([s]) =>
      s.startsWith('INSERT INTO "assistant_faq"'),
    );
    expect(plantillas).toHaveLength(5);
    plantillas.forEach(([, params], i) => {
      const [, clave, pregunta, respuesta, posicion] = params as [
        string,
        string,
        string,
        string,
        number,
      ];
      expect(clave).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect([...pregunta].length).toBeGreaterThanOrEqual(5);
      expect([...pregunta].length).toBeLessThanOrEqual(200);
      expect([...respuesta].length).toBeLessThanOrEqual(1500);
      expect(HTML.test(pregunta) || HTML.test(respuesta)).toBe(false);
      expect(posicion).toBe(i + 1);
    });
  });

  describe('migración 112: las plantillas de OrixTech pasan al catálogo', () => {
    it('crea los únicos entre las vigentes: clave, pregunta (sin mayúsculas ni bordes) y posición', async () => {
      const sql = (await subida112()).map(([s]) => s).join('\n');
      expect(sql).toContain(
        'CREATE UNIQUE INDEX "UQ_assistant_faq_template_clave_vigente" ON "assistant_faq_template" ("key") WHERE "deleted_at" IS NULL',
      );
      expect(sql).toContain(
        'CREATE UNIQUE INDEX "UQ_assistant_faq_template_pregunta_vigente" ON "assistant_faq_template" (lower(btrim("question"))) WHERE "deleted_at" IS NULL',
      );
      expect(sql).toContain(
        'CREATE UNIQUE INDEX "UQ_assistant_faq_template_posicion_vigente" ON "assistant_faq_template" ("position") WHERE "deleted_at" IS NULL',
      );
    });

    it('copia sólo las plantillas vigentes de la plataforma, en su orden, antes de darlas de baja (lógica) y de quitar la columna', async () => {
      const sql = (await subida112()).map(([s]) => s);
      const copia = sql.findIndex((s) =>
        s.startsWith('INSERT INTO "assistant_faq_template"'),
      );
      const baja = sql.findIndex((s) => s.includes('UPDATE "assistant_faq"'));
      const columna = sql.findIndex((s) =>
        s.includes('DROP COLUMN "use_as_template"'),
      );
      expect(copia).toBeGreaterThan(-1);
      expect(copia).toBeLessThan(baja);
      expect(baja).toBeLessThan(columna);
      const filtro =
        '"distributor_id" IS NULL AND "use_as_template" AND "deleted_at" IS NULL';
      expect(sql[copia]).toContain(filtro);
      expect(sql[copia]).toContain(
        'row_number() OVER (ORDER BY "position", "created_at", "faq_id")',
      );
      expect(sql[baja]).toContain(filtro);
      expect(sql[baja]).toContain('SET "deleted_at" = now()');
      expect(sql[baja]).toContain('SET "version" = "version" + 1');
      // Nada se borra: ni preguntas de OrixTech ni de las distribuidoras.
      expect(sql.join('\n')).not.toMatch(/DELETE\s+FROM|TRUNCATE/i);
      expect(sql.join('\n')).not.toMatch(
        /"distributor_id" IS NOT NULL|"distributor_id" = /,
      );
    });

    it('down vuelve a la columna y su CHECK, reinserta los ejemplos vigentes como plantillas nuevas con el texto del catálogo y quita el catálogo, sin borrar preguntas', async () => {
      const sql = (await bajada112()).map(([s]) => s);
      expect(sql[1]).toBe(
        'ALTER TABLE "assistant_faq" ADD "use_as_template" boolean NOT NULL DEFAULT false',
      );
      expect(sql[2]).toContain(
        'ADD CONSTRAINT "CHK_assistant_faq_plantilla" CHECK ("distributor_id" IS NULL OR NOT "use_as_template")',
      );
      const alta = sql.find((s) =>
        s.startsWith('INSERT INTO "assistant_faq" ('),
      );
      expect(alta).toContain('"t"."key", "t"."question", "t"."answer"');
      expect(alta).toContain('"t"."deleted_at" IS NULL');
      expect(alta).toContain('row_number() OVER (ORDER BY "t"."position")');
      // Todas las vigentes del catálogo, sin saltear ninguna por parecido.
      expect(alta).not.toContain('NOT EXISTS');
      expect(sql.at(-1)).toBe('DROP TABLE "assistant_faq_template"');
      expect(sql.filter((s) => /DELETE\s+FROM|TRUNCATE/i.test(s))).toEqual([]);
    });

    it('down nunca toca las preguntas propias de OrixTech (D-B6): si una vigente choca con un ejemplo, falla antes de cambiar nada', async () => {
      const sql = (await bajada112()).map(([s]) => s);
      // Lo primero es el control; nada antes.
      expect(sql[0]).toMatch(/^DO \$\$/);
      expect(sql[0]).toContain(
        '"f"."distributor_id" IS NULL AND "f"."deleted_at" IS NULL',
      );
      expect(sql[0]).toContain('"f"."key" = "t"."key"');
      expect(sql[0]).toContain(
        'lower(btrim("f"."question")) = lower(btrim("t"."question"))',
      );
      expect(sql[0]).toContain('"t"."deleted_at" IS NULL');
      expect(sql[0]).toMatch(
        /RAISE EXCEPTION 'No se puede deshacer el catálogo de preguntas de ejemplo: la base de OrixTech tiene preguntas propias vigentes/,
      );
      // Ninguna sentencia modifica filas existentes de assistant_faq.
      expect(
        sql.filter((s) => /UPDATE\s+"assistant_faq"(?!_)/.test(s)),
      ).toEqual([]);
    });

    it('up instala la auditoría de la tabla nueva antes de copiar (cada copia deja su asiento de alta), con el mismo mapa que la 113', async () => {
      const corridas = await subida112();
      const sql = corridas.map(([s]) => s);
      const aplicar = sql.indexOf('SELECT auditoria_aplicar_mapa($1::jsonb)');
      const crear = sql.findIndex((s) =>
        s.startsWith('CREATE TABLE "assistant_faq_template"'),
      );
      const copia = sql.findIndex((s) =>
        s.startsWith('INSERT INTO "assistant_faq_template"'),
      );
      expect(crear).toBeLessThan(aplicar);
      expect(aplicar).toBeLessThan(copia);
      const tramo = JSON.parse(
        (corridas[aplicar][1] as string[])[0],
      ) as typeof MAPA_DEL_CATALOGO;
      expect(tramo).toEqual({
        entities: mapaGuardado.entities.filter(
          (e) => e.table === 'assistant_faq_template',
        ),
        fields: mapaGuardado.fields.filter(
          (f) => f.table === 'assistant_faq_template',
        ),
      });
      expect(tramo.entities).toHaveLength(1);
      expect(tramo.fields.map((f) => f.column)).toEqual([
        'template_id',
        'key',
        'question',
        'answer',
        'position',
        'updated_by',
        'deleted_at',
      ]);
    });
  });
});
