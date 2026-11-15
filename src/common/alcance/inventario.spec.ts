import { readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { RoleType } from '../constants/role-type.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { resolverAlcance } from './resolver-alcance';

interface Ruta {
  ruta: string;
  alcance: ReturnType<typeof resolverAlcance>;
  conSuperAdmin: boolean;
  publica: boolean;
}

/** Un camino de la metadata de Nest (texto o lista de textos). */
const camino = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : Array.isArray(v) && typeof v[0] === 'string'
      ? v[0]
      : '';

function controllers(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return controllers(ruta);
    return ruta.endsWith('.controller.ts') ? [ruta] : [];
  });
}

const unir = (...partes: string[]): string =>
  '/' +
  partes
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');

/** Todas las rutas del back con su alcance para el super admin, leídas de la metadata. */
function inventario(): Ruta[] {
  const reflector = new Reflector();
  const rutas: Ruta[] = [];
  for (const archivo of controllers(join(__dirname, '..', '..'))) {
    const modulo = jest.requireActual<Record<string, unknown>>(archivo);
    for (const exportado of Object.values(modulo)) {
      if (typeof exportado !== 'function') continue;
      const base: unknown = Reflect.getMetadata(PATH_METADATA, exportado);
      if (base === undefined) continue;
      const versionDeClase: unknown = Reflect.getMetadata(
        VERSION_METADATA,
        exportado,
      );
      const proto = (exportado as { prototype: Record<string, unknown> })
        .prototype;
      for (const nombre of Object.getOwnPropertyNames(proto)) {
        const handler = proto[nombre];
        if (typeof handler !== 'function' || nombre === 'constructor') continue;
        const metodo: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (metodo === undefined) continue;
        const subruta: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        const version: unknown =
          Reflect.getMetadata(VERSION_METADATA, handler) ?? versionDeClase;
        const roles = reflector.getAllAndOverride<RoleType[] | undefined>(
          ROLES_KEY,
          [handler as () => void, exportado as () => void],
        );
        rutas.push({
          ruta: `${RequestMethod[metodo as RequestMethod]} ${unir(
            typeof version === 'string' ? `v${version}` : '',
            camino(base),
            camino(subruta),
          )}`,
          alcance: resolverAlcance(reflector, [handler, exportado]),
          publica: Boolean(
            reflector.getAllAndOverride<boolean | undefined>('isPublic', [
              handler as () => void,
              exportado as () => void,
            ]),
          ),
          conSuperAdmin:
            !roles ||
            roles.length === 0 ||
            roles.includes(RoleType.SUPER_ADMIN),
        });
      }
    }
  }
  return rutas.sort((a, b) => a.ruta.localeCompare(b.ruta));
}

/**
 * Lo que el super admin ve FUERA del modo soporte. Si cambia, es una decisión
 * de seguridad (diseño §2.3): un endpoint nuevo nace `empresa` y entra acá
 * sólo marcado a mano con `@Alcance(...)` o con `@Auth(RoleType.SUPER_ADMIN)`.
 */
const PLATAFORMA = [
  'DELETE /distributor/:id',
  'DELETE /role/:id',
  'DELETE /v2/support-sessions/:id',
  'GET /distributor',
  'GET /distributor/:id',
  'GET /role',
  'GET /role/:id',
  'GET /notifications/user/:userId',
  // Panel de plataforma (E3) y monitoreo de procesos (pasó de «ambos» a plataforma).
  'GET /v2/platform/activity',
  'GET /v2/platform/companies',
  'GET /v2/platform/companies/:id',
  'GET /v2/platform/companies/:id/scheduled-tasks',
  'GET /v2/platform/companies/:id/theme',
  // Módulos por distribuidora (P1).
  'GET /v2/platform/companies/:id/modules',
  'GET /v2/platform/document-reading-usage',
  'GET /v2/platform/overview',
  'GET /v2/platform/processes',
  'GET /v2/process-runs',
  'GET /v2/process-runs/:runId',
  'GET /v2/process-runs/summary',
  // Monitor O1: la traza de punta a punta (DISENO-OBSERVABILIDAD §7.5).
  'GET /v2/platform/traces/:traceId',
  'PUT /v2/platform/companies/:id/scheduled-tasks',
  'GET /v2/support-sessions',
  'GET /v2/support-sessions/:id',
  'GET /v2/support-sessions/:id/accesses',
  'GET /v2/support-sessions/current',
  'PATCH /distributor/:id',
  'PATCH /role/:id',
  'POST /admin',
  'POST /distributor',
  'POST /email/test',
  'POST /notifications/send-test',
  'POST /role',
  'POST /role/seed',
  'POST /v2/support-sessions',
  'PUT /v2/platform/companies/:id/owned-by-platform',
  'PUT /v2/platform/companies/:id/modules/:key',
  // Mensajería (CH1): chat con las empresas, tickets y configuración del soporte.
  'GET /v2/platform/chats',
  'GET /v2/platform/chats/:id',
  'GET /v2/platform/chats/:id/messages',
  'POST /v2/platform/chats',
  'POST /v2/platform/chats/:id/close',
  'POST /v2/platform/chats/:id/messages',
  'POST /v2/platform/chats/:id/read',
  'POST /v2/platform/chats/:id/release',
  'POST /v2/platform/chats/:id/take',
  'POST /v2/platform/chats/:id/tickets',
  'GET /v2/platform/tickets',
  'GET /v2/platform/tickets/:id',
  'GET /v2/platform/tickets/:id/messages',
  'PATCH /v2/platform/tickets/:id',
  'POST /v2/platform/tickets',
  'POST /v2/platform/tickets/:id/excerpts',
  'POST /v2/platform/tickets/:id/messages',
  'POST /v2/platform/tickets/:id/read',
  'GET /v2/platform/support-settings',
  'GET /v2/platform/support/summary',
  'PUT /v2/platform/support-settings',
  'GET /v2/platform/ticket-templates',
  'POST /v2/platform/ticket-templates',
  'PATCH /v2/platform/ticket-templates/:id',
  'DELETE /v2/platform/ticket-templates/:id',
];

const AMBOS = [
  'DELETE /admin/:id',
  'DELETE /users/:id',
  'DELETE /users/me/photo',
  'GET /admin',
  'GET /admin/:id',
  'GET /admin/term/:term',
  'GET /audit',
  'GET /distributor/current',
  'GET /users',
  'GET /users/:id',
  'GET /users/email/:email',
  'GET /users/me/photo',
  'GET /users/phone/:phoneNumber',
  'GET /v2/admin-notifications',
  'GET /v2/admin-notifications/unread-count',
  'GET /v2/me/permissions',
  'GET /v2/permissions',
  'PATCH /admin/:id',
  'PATCH /users/:id',
  'PATCH /users/:id/block',
  'PATCH /v2/admin-notifications/:id/read',
  'PATCH /v2/admin-notifications/read-all',
  'POST /auth',
  'POST /email/change-email',
  'PUT /users/me/photo',
];

describe('alcance de cada ruta para el super admin (modo soporte)', () => {
  const rutas = inventario();
  const de = (alcance: string) =>
    rutas.filter((r) => r.alcance === alcance).map((r) => r.ruta);

  // `ALCANCE_SALIDA=<archivo>` deja el listado completo para revisarlo a ojo
  // contra el diseño (§2.3).
  const salida = process.env.ALCANCE_SALIDA;
  if (salida) {
    writeFileSync(
      salida,
      rutas.map((r) => `${r.alcance ?? 'no aplica'}\t${r.ruta}`).join('\n'),
    );
  }

  it('encuentra las rutas del back (si no, el test no prueba nada)', () => {
    expect(rutas.length).toBeGreaterThan(500);
  });

  it('las de plataforma son exactamente las revisadas', () => {
    expect(de('plataforma')).toEqual(
      [...PLATAFORMA].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('las de las dos versiones son exactamente las revisadas', () => {
    expect(de('ambos')).toEqual([...AMBOS].sort((a, b) => a.localeCompare(b)));
  });

  it('toda ruta abierta al super admin tiene un alcance resuelto, salvo las públicas', () => {
    const sinResolver = rutas
      .filter((r) => r.conSuperAdmin && r.alcance === null && !r.publica)
      .map((r) => r.ruta);
    expect(sinResolver).toEqual([]);
  });

  it('la mayoría queda cerrada por defecto (empresa)', () => {
    expect(de('empresa').length).toBeGreaterThan(400);
  });

  it('el listado global de direcciones y el push de confirmación son de empresa', () => {
    const empresa = de('empresa');
    expect(empresa).toContain('GET /user-address');
    expect(empresa).toContain('POST /notifications/order-confirmation');
  });

  it('la frecuencia de las tareas programadas de la empresa (v1) sigue siendo de empresa: la plataforma la cambia por v2', () => {
    const empresa = de('empresa');
    expect(empresa).toContain('GET /module-config/scheduled_tasks');
    expect(empresa).toContain('PUT /module-config/scheduled_tasks');
  });

  it('el lado de la empresa del modo soporte no es del super admin', () => {
    expect(
      rutas
        .filter((r) => r.ruta.includes('/v2/support-access'))
        .every((r) => r.alcance === null && !r.conSuperAdmin),
    ).toBe(true);
  });
});
