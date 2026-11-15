import { getMetadataArgsStorage, type QueryRunner } from 'typeorm';
import { BaseDeConocimientoDelAsistente1795000000110 } from '../../migrations/1795000000110-BaseDeConocimientoDelAsistente';
import { HTML, HTML_EN_LA_BASE } from '../texto-plano';
import { AssistantFaq } from './assistant-faq.entity';
import { AssistantKnowledgeBase } from './assistant-knowledge-base.entity';

/** Las sentencias que corre la migración 110, sin base. */
async function sentencias(): Promise<Array<[string, unknown[] | undefined]>> {
  const corridas: Array<[string, unknown[] | undefined]> = [];
  const runner = {
    query: (sql: string, params?: unknown[]) => {
      corridas.push([sql, params]);
      return Promise.resolve([{ id: 'base-plataforma' }]);
    },
  } as unknown as QueryRunner;
  await new BaseDeConocimientoDelAsistente1795000000110().up(runner);
  return corridas;
}

describe('restricciones de la base de conocimiento (migración 110 y entidades)', () => {
  it('la migración crea exactamente los CHECK que declaran las entidades', async () => {
    const sql = (await sentencias()).map(([s]) => s);
    for (const [entidad, tabla] of [
      [AssistantFaq, 'assistant_faq'],
      [AssistantKnowledgeBase, 'assistant_knowledge_base'],
    ] as const) {
      const crear = sql.find((s) => s.startsWith(`CREATE TABLE "${tabla}"`));
      const checks = getMetadataArgsStorage().checks.filter(
        (c) => c.target === entidad,
      );
      expect(checks.length).toBeGreaterThan(0);
      for (const c of checks) {
        expect(crear).toContain(
          `CONSTRAINT "${c.name}" CHECK (${c.expression})`,
        );
      }
      expect(crear?.match(/CONSTRAINT "CHK_/g)).toHaveLength(checks.length);
    }
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
});
