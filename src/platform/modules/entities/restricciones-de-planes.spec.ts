import type { QueryRunner } from 'typeorm';
import { ModulosPorDistribuidora1795000000042 } from '../../../migrations/1795000000042-ModulosPorDistribuidora';
import { CHECKS_DE_LA_BANDEJA } from '../../../migrations/1795000000100-BandejaDeLaEmpresa';
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
    // La 042 fija el catálogo de entonces; la 100 lo amplía con `chat`.
    expect(excepcion).toContain(
      `CONSTRAINT "CHK_distributor_module_clave" CHECK ("module_key" IN ('document_reading', 'route_planning', 'route_batching', 'repurchase', 'cylinder_recovery', 'fleet_planner', 'whatsapp', 'mercadopago', 'express'))`,
    );
    const ampliados = CHECKS_DE_LA_BANDEJA.filter(([, nombre]) =>
      nombre.endsWith('_module_clave'),
    ).map(([tabla, nombre, nueva]) => [tabla, nombre, nueva]);
    expect(ampliados).toEqual([
      [
        'distributor_module',
        'CHK_distributor_module_clave',
        checkModuloConocido('module_key'),
      ],
      [
        'platform_plan_module',
        'CHK_platform_plan_module_clave',
        checkModuloConocido('module_key'),
      ],
    ]);
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
