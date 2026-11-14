import type { QueryRunner } from 'typeorm';
import { ModulosPorDistribuidora1795000000042 } from '../../../migrations/1795000000042-ModulosPorDistribuidora';
import { checkModuloConocido } from '../catalogo-de-modulos';
import { CHECK_FOTO_DEL_PLAN } from './distributor-subscription.entity';
import {
  CHECK_LIMITES_DEL_PLAN,
  CLAVES_DE_LIMITES,
} from './platform-plan.entity';

/** Las sentencias (y sus parámetros) que corre la migración, sin base. */
async function sentencias(): Promise<Array<[string, unknown[] | undefined]>> {
  const corridas: Array<[string, unknown[] | undefined]> = [];
  const runner = {
    query: (sql: string, params?: unknown[]) => {
      corridas.push([sql, params]);
      return Promise.resolve([]);
    },
  } as unknown as QueryRunner;
  await new ModulosPorDistribuidora1795000000042().up(runner);
  return corridas;
}

describe('restricciones de planes y suscripciones (migración 042 y entidades)', () => {
  it('los CHECK sobre JSON exigen las claves obligatorias: un CHECK que da NULL pasa', () => {
    // Una clave ausente hace NULL a `->`: sin `?&` ni COALESCE el CHECK pasaría.
    expect(CHECK_LIMITES_DEL_PLAN).toMatch(/^COALESCE\(.*, false\)$/);
    expect(CHECK_LIMITES_DEL_PLAN).toContain(
      `"limits" ?& ARRAY[${CLAVES_DE_LIMITES.map((k) => `'${k}'`).join(', ')}]`,
    );
    expect(CHECK_FOTO_DEL_PLAN).toMatch(/^COALESCE\(.*, false\)$/);
    expect(CHECK_FOTO_DEL_PLAN).toContain(
      `"plan_snapshot" ?& ARRAY['modules', 'limits']`,
    );
  });

  it('la migración crea exactamente los CHECK que declaran las entidades', async () => {
    const sql = (await sentencias()).map(([s]) => s);
    const plan = sql.find((s) => s.startsWith('CREATE TABLE "platform_plan"'));
    const suscripcion = sql.find((s) =>
      s.startsWith('CREATE TABLE "distributor_subscription"'),
    );
    const excepcion = sql.find((s) =>
      s.startsWith('CREATE TABLE "distributor_module"'),
    );
    expect(plan).toContain(
      `CONSTRAINT "CHK_platform_plan_limites" CHECK (${CHECK_LIMITES_DEL_PLAN})`,
    );
    expect(suscripcion).toContain(
      `CONSTRAINT "CHK_distributor_subscription_foto" CHECK (${CHECK_FOTO_DEL_PLAN})`,
    );
    expect(excepcion).toContain(
      `CONSTRAINT "CHK_distributor_module_clave" CHECK (${checkModuloConocido('module_key')})`,
    );
  });

  it('los planes sembrados traen las cuatro claves de topes', async () => {
    const planes = (await sentencias()).filter(([s]) =>
      s.startsWith('INSERT INTO "platform_plan" '),
    );
    expect(planes).toHaveLength(3);
    for (const [, params] of planes) {
      const topes = JSON.parse(String(params?.[4])) as Record<string, unknown>;
      expect(Object.keys(topes).sort()).toEqual([...CLAVES_DE_LIMITES].sort());
    }
  });
});
