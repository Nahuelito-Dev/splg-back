import { readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { REQUIERE_MODULO_KEY } from './requiere-modulo.decorator';

interface Ruta {
  ruta: string;
  /** Carpeta del archivo, relativa a `src/`. */
  archivo: string;
  /** Módulo atado, `null` si está marcada `@SinModulo`, `undefined` si nada. */
  modulo: string | null | undefined;
  motivo: string | undefined;
  /** El 403 que queda en Swagger para la ruta (el del método manda). */
  descripcion403: string | undefined;
}

const RAIZ = join(__dirname, '..', '..');

/** Los controllers: `*.controller.ts` y los archivos con varios, `*.controllers.ts`. */
function controllers(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) return controllers(ruta);
    return /\.controllers?\.ts$/.test(nombre) ? [ruta] : [];
  });
}

const camino = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : Array.isArray(v) && typeof v[0] === 'string'
      ? v[0]
      : '';

const unir = (...partes: string[]): string =>
  '/' +
  partes
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');

type Respuestas = Record<string, { description?: string } | undefined>;

function inventario(): Ruta[] {
  const reflector = new Reflector();
  const rutas: Ruta[] = [];
  for (const archivo of controllers(RAIZ)) {
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
        const objetivos = [handler as () => void, exportado as () => void];
        const propias = Reflect.getMetadata(
          DECORATORS.API_RESPONSE,
          handler,
        ) as Respuestas | undefined;
        const deClase = Reflect.getMetadata(
          DECORATORS.API_RESPONSE,
          exportado,
        ) as Respuestas | undefined;
        rutas.push({
          ruta: `${RequestMethod[metodo as RequestMethod]} ${unir(
            typeof version === 'string' ? `v${version}` : '',
            camino(base),
            camino(subruta),
          )}`,
          archivo: relative(RAIZ, archivo).split(sep).join('/'),
          modulo: reflector.getAllAndOverride<string | null | undefined>(
            REQUIERE_MODULO_KEY,
            objetivos,
          ),
          motivo: reflector.get<string | undefined>(
            'sinModuloMotivo',
            handler as () => void,
          ),
          descripcion403: (propias?.['403'] ?? deClase?.['403'])?.description,
        });
      }
    }
  }
  return rutas.sort((a, b) => a.ruta.localeCompare(b.ruta));
}

/**
 * Las carpetas de los módulos (§6.2): toda ruta de un controller de acá está
 * atada a su módulo o es una excepción revisada. Un controller nuevo en una de
 * estas carpetas sin `@RequiereModulo` rompe el test.
 */
const CARPETAS_DE_MODULOS = [
  'document-reading/',
  'repurchase-forecast/',
  'route-batch/',
  'cylinder/recovery/',
  'fleet/planner/',
  'mp-reconciliation/',
  'chat/presentation/bandeja/',
  'assistant/',
];

/** Qué ruta va con qué módulo. Cambiarlo es una decisión de producto (§3.5). */
const ATADAS: Record<string, string> = {
  // M6 lector de documentos.
  'GET /v2/document-readings': 'document_reading',
  'GET /v2/document-readings/:id': 'document_reading',
  'GET /v2/document-readings/spend': 'document_reading',
  'POST /v2/document-readings/:id/confirm': 'document_reading',
  'POST /v2/document-readings/:id/correct': 'document_reading',
  'POST /v2/document-readings/:id/reject': 'document_reading',
  'POST /v2/document-readings/run': 'document_reading',
  // M3 recompra (panel y app del cliente).
  'GET /v2/customers/me/repurchase': 'repurchase',
  'GET /v2/customers/me/repurchase/notice': 'repurchase',
  'PATCH /v2/customers/me/repurchase/notice': 'repurchase',
  'GET /v2/repurchase/forecast': 'repurchase',
  'GET /v2/repurchase/forecast/customers/:userId': 'repurchase',
  'GET /v2/repurchase/invitations': 'repurchase',
  'GET /v2/repurchase/stats': 'repurchase',
  'POST /v2/repurchase/run': 'repurchase',
  // M4 agrupación por recorrido.
  'GET /v2/route-batches': 'route_batching',
  'GET /v2/route-batches/:id': 'route_batching',
  'GET /v2/route-batches/settings': 'route_batching',
  'PATCH /v2/route-batches/settings': 'route_batching',
  'POST /v2/route-batches/:id/dissolve': 'route_batching',
  'POST /v2/route-batches/run': 'route_batching',
  // M4 hoja de ruta.
  'GET /v2/route-plans/:date': 'route_planning',
  'GET /v2/route-plans/:date/late-orders': 'route_planning',
  'POST /v2/route-plans/:date/close': 'route_planning',
  'POST /v2/route-plans/:date/confirm-all': 'route_planning',
  'POST /v2/route-plans/:date/open': 'route_planning',
  'POST /v2/route-plans/:date/propose': 'route_planning',
  'GET /v2/route-planning/settings': 'route_planning',
  'PATCH /v2/route-planning/settings': 'route_planning',
  'GET /v2/route-planning/holidays': 'route_planning',
  'POST /v2/route-planning/holidays': 'route_planning',
  'DELETE /v2/route-planning/holidays/:id': 'route_planning',
  'POST /v2/route-sheets': 'route_planning',
  'GET /v2/route-sheets': 'route_planning',
  'GET /v2/route-sheets/:id': 'route_planning',
  'PATCH /v2/route-sheets/:id': 'route_planning',
  'POST /v2/route-sheets/:id/stops': 'route_planning',
  'DELETE /v2/route-sheets/:id/stops/:orderId': 'route_planning',
  'POST /v2/route-sheets/:id/stops/:orderId/move': 'route_planning',
  'PUT /v2/route-sheets/:id/sequence': 'route_planning',
  'POST /v2/route-sheets/:id/optimize': 'route_planning',
  'POST /v2/route-sheets/:id/confirm': 'route_planning',
  'POST /v2/route-sheets/:id/reopen': 'route_planning',
  'POST /v2/route-sheets/:id/cancel': 'route_planning',
  'GET /v2/route-sheets/:id/load-suggestion': 'route_planning',
  'GET /v2/route-sheets/:id/path': 'route_planning',
  'GET /v2/route-sheets/:id/pdf': 'route_planning',
  // Iniciar una hoja es empezar algo nuevo (§7.3): exige el módulo.
  'POST /v2/route-sheets/:id/start': 'route_planning',
  'POST /v2/driver/route-sheets/:id/start': 'route_planning',
  // M5 recupero de envases (panel).
  'GET /v2/cylinder-recovery/cases': 'cylinder_recovery',
  'GET /v2/cylinder-recovery/cases/:id': 'cylinder_recovery',
  'POST /v2/cylinder-recovery/cases/:id/resolve': 'cylinder_recovery',
  'GET /v2/cylinder-recovery/report': 'cylinder_recovery',
  'GET /v2/cylinder-recovery/settings': 'cylinder_recovery',
  'PATCH /v2/cylinder-recovery/settings': 'cylinder_recovery',
  'POST /v2/cylinder-recovery/run': 'cylinder_recovery',
  // M2 planificador de taller (panel y app del chofer).
  'GET /v2/fleet/maintenance-planner': 'fleet_planner',
  'GET /v2/fleet/maintenance-planner/forecast': 'fleet_planner',
  'GET /v2/fleet/maintenance-planner/settings': 'fleet_planner',
  'PATCH /v2/fleet/maintenance-planner/settings': 'fleet_planner',
  'POST /v2/fleet/maintenance-planner/run': 'fleet_planner',
  'GET /v2/fleet/maintenance-planner/cases/:id': 'fleet_planner',
  'POST /v2/fleet/maintenance-planner/cases/:id/confirm': 'fleet_planner',
  'POST /v2/fleet/maintenance-planner/cases/:id/cancel': 'fleet_planner',
  'POST /v2/fleet/maintenance-planner/tasks/:taskId/force-window':
    'fleet_planner',
  'POST /v2/fleet/maintenance-planner/tasks/:taskId/replan': 'fleet_planner',
  'GET /v2/driver/maintenance-proposals': 'fleet_planner',
  'GET /v2/driver/maintenance-proposals/:id': 'fleet_planner',
  'GET /v2/driver/maintenance-proposals/settings': 'fleet_planner',
  'POST /v2/driver/maintenance-proposals/:id/accept': 'fleet_planner',
  'POST /v2/driver/maintenance-proposals/:id/reject': 'fleet_planner',
  // Cobro con Mercado Pago: abrir una conciliación nueva.
  'POST /v2/mercadopago/reconciliations': 'mercadopago',
  // M8 asistente del chat: la base de conocimiento de la empresa.
  'GET /v2/company/assistant/faqs': 'assistant',
  'POST /v2/company/assistant/faqs': 'assistant',
  'POST /v2/company/assistant/faqs/from-templates': 'assistant',
  'PATCH /v2/company/assistant/faqs/:id': 'assistant',
  'DELETE /v2/company/assistant/faqs/:id': 'assistant',
  'GET /v2/company/assistant/templates': 'assistant',
  // Compra express (fuera de las carpetas de módulos).
  'GET /module-config/express_dispatch': 'express',
  'PUT /module-config/express_dispatch': 'express',
  'POST /orders/express': 'express',
  'POST /orders/express/quote': 'express',
  // Bandeja de la empresa: clientes y choferes (CH3). El chat con la
  // plataforma y los tickets (C1) son núcleo y quedan fuera.
  'GET /v2/conversations': 'chat',
  'POST /v2/conversations': 'chat',
  'POST /v2/conversations/broadcast-drivers': 'chat',
  'GET /v2/conversations/summary': 'chat',
  'GET /v2/conversations/:id': 'chat',
  'GET /v2/conversations/:id/assignees': 'chat',
  'GET /v2/conversations/:id/messages': 'chat',
  'GET /v2/conversations/:id/suggestions': 'chat',
  'POST /v2/conversations/:id/mentions/read': 'chat',
  'GET /v2/conversations/csat': 'chat',
  'GET /v2/me/conversations/actions': 'chat',
  'POST /v2/me/conversations/:id/actions': 'chat',
  'POST /v2/me/conversations/:id/rating': 'chat',
  'POST /v2/conversations/:id/messages': 'chat',
  'POST /v2/conversations/:id/attachments': 'chat',
  'GET /v2/conversations/:id/messages/:messageId/attachment': 'chat',
  'POST /v2/conversations/:id/notes': 'chat',
  'PATCH /v2/conversations/:id/messages/:messageId': 'chat',
  'POST /v2/conversations/:id/assign': 'chat',
  'POST /v2/conversations/:id/close': 'chat',
  'POST /v2/conversations/:id/reopen': 'chat',
  'POST /v2/conversations/:id/read': 'chat',
  'POST /v2/conversations/:id/claim': 'chat',
  'GET /v2/chat/settings': 'chat',
  'PUT /v2/chat/settings': 'chat',
  'GET /v2/chat/business-hours': 'chat',
  'PUT /v2/chat/business-hours': 'chat',
  'GET /v2/chat/templates': 'chat',
  'POST /v2/chat/templates': 'chat',
  'PATCH /v2/chat/templates/:id': 'chat',
  'DELETE /v2/chat/templates/:id': 'chat',
  'GET /v2/me/conversations': 'chat',
  'POST /v2/me/conversations': 'chat',
  'GET /v2/me/conversations/:id': 'chat',
  'GET /v2/me/conversations/:id/messages': 'chat',
  'POST /v2/me/conversations/:id/messages': 'chat',
  'POST /v2/me/conversations/:id/attachments': 'chat',
  'GET /v2/me/conversations/:id/messages/:messageId/attachment': 'chat',
  'PATCH /v2/me/conversations/:id/messages/:messageId': 'chat',
  'DELETE /v2/me/conversations/:id/messages/:messageId': 'chat',
  'POST /v2/me/conversations/:id/read': 'chat',
};

/**
 * Rutas de las carpetas de módulos que siguen andando con el módulo apagado:
 * lo que está en curso termina (§7.3). Cada una con su motivo.
 */
const EXCEPCIONES: Record<string, string> = {
  'GET /v2/driver/route-batches':
    'Los lotes ya ofrecidos terminan: el chofer los ve hasta cerrarlos',
  'GET /v2/driver/route-batches/:id':
    'Los lotes ya ofrecidos terminan: el chofer los ve hasta cerrarlos',
  'POST /v2/driver/route-batches/:id/accept':
    'Los lotes ya ofrecidos terminan: el chofer responde la oferta vigente',
  'POST /v2/driver/route-batches/:id/reject':
    'Los lotes ya ofrecidos terminan: el chofer responde la oferta vigente',
  'GET /v2/driver/route-sheets/current': 'La hoja del día en curso se termina',
  'GET /v2/driver/route-sheets/:id': 'La hoja del día en curso se termina',
  'POST /v2/driver/route-sheets/:id/stops/:orderId/on-the-way':
    'La hoja del día en curso se termina',
  'POST /v2/driver/route-sheets/:id/stops/:orderId/arrived':
    'La hoja del día en curso se termina',
  'POST /v2/driver/route-sheets/:id/stops/:orderId/failed':
    'La hoja del día en curso se termina',
  'POST /v2/driver/route-sheets/:id/close':
    'La hoja del día en curso se termina',
  'GET /v2/customers/me/repurchase/invitations':
    'Las invitaciones vigentes se respetan hasta su vencimiento aunque se apague la recompra (§7.3)',
  'GET /v2/customers/me/repurchase/invitations/:id':
    'Las invitaciones vigentes se respetan hasta su vencimiento aunque se apague la recompra (§7.3)',
  'POST /v2/customers/me/repurchase/invitations/:id/accept':
    'Las invitaciones vigentes se respetan hasta su vencimiento aunque se apague la recompra (§7.3)',
  'POST /v2/customers/me/repurchase/invitations/:id/dismiss':
    'Las invitaciones vigentes se respetan hasta su vencimiento aunque se apague la recompra (§7.3)',
  'GET /v2/orders/:id/eta':
    'La hora estimada de un pedido ya planificado sigue hasta entregarlo',
  'GET /v2/route-sheets/:id/execution':
    'La hoja del día en curso se termina aunque se apague la hoja de ruta',
  'POST /v2/route-sheets/:id/stops/:orderId/failed':
    'La hoja del día en curso se termina aunque se apague la hoja de ruta',
  'POST /v2/route-sheets/:id/close':
    'La hoja del día en curso se termina aunque se apague la hoja de ruta',
  'GET /v2/cylinder-recovery/mine':
    'Las ofertas de retiro vigentes siguen: el cliente las ve',
  'POST /v2/cylinder-recovery/mine/:id/pickup/accept':
    'Las ofertas de retiro vigentes siguen: el cliente las responde',
  'POST /v2/cylinder-recovery/mine/:id/pickup/decline':
    'Las ofertas de retiro vigentes siguen: el cliente las responde',
  'GET /v2/cylinder-recovery/driver/pickups':
    'Los retiros ya acordados se hacen en la entrega',
  'POST /v2/cylinder-recovery/driver/pickups/:noticeId/confirm':
    'Los retiros ya acordados se hacen en la entrega',
  'POST /v2/cylinder-recovery/driver/pickups/:noticeId/not-collected':
    'Los retiros ya acordados se hacen en la entrega',
  'GET /v2/mercadopago/reconciliations':
    'Con Mercado Pago apagado la conciliación queda en sólo lectura hasta conciliar lo ya cobrado',
  'GET /v2/mercadopago/reconciliations/:id':
    'Con Mercado Pago apagado la conciliación queda en sólo lectura hasta conciliar lo ya cobrado',
  'GET /v2/mercadopago/reconciliations/:id/report':
    'Con Mercado Pago apagado la conciliación queda en sólo lectura hasta conciliar lo ya cobrado',
  'POST /v2/mercadopago/reconciliations/:id/apply':
    'Conciliar lo ya cobrado sigue con Mercado Pago apagado: es plata ya movida',
  'GET /v2/platform/assistant/faqs':
    'La base del asistente de OrixTech es de la plataforma: no depende del módulo de ninguna empresa',
  'POST /v2/platform/assistant/faqs':
    'La base del asistente de OrixTech es de la plataforma: no depende del módulo de ninguna empresa',
  'PATCH /v2/platform/assistant/faqs/:id':
    'La base del asistente de OrixTech es de la plataforma: no depende del módulo de ninguna empresa',
  'DELETE /v2/platform/assistant/faqs/:id':
    'La base del asistente de OrixTech es de la plataforma: no depende del módulo de ninguna empresa',
  'GET /v2/platform/assistant/templates':
    'El catálogo de preguntas de ejemplo lo administra la plataforma: no depende del módulo de ninguna empresa',
  'POST /v2/platform/assistant/templates':
    'El catálogo de preguntas de ejemplo lo administra la plataforma: no depende del módulo de ninguna empresa',
  'PATCH /v2/platform/assistant/templates/:id':
    'El catálogo de preguntas de ejemplo lo administra la plataforma: no depende del módulo de ninguna empresa',
  'DELETE /v2/platform/assistant/templates/:id':
    'El catálogo de preguntas de ejemplo lo administra la plataforma: no depende del módulo de ninguna empresa',
};

/** Deciden el módulo en el servicio (el proceso viene en la ruta) y documentan su 403. */
const DINAMICAS = [
  'GET /module-config/:process',
  'PUT /module-config/:process',
];

const ordenar = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

describe('inventario de los endpoints de cada módulo (§6.2)', () => {
  const rutas = inventario();
  const deCarpetas = rutas.filter((r) =>
    CARPETAS_DE_MODULOS.some((c) => r.archivo.startsWith(c)),
  );

  // `MODULOS_SALIDA=<archivo>` deja el listado completo para revisarlo a ojo.
  const salida = process.env.MODULOS_SALIDA;
  if (salida) {
    writeFileSync(
      salida,
      rutas
        .filter((r) => r.modulo !== undefined || deCarpetas.includes(r))
        .map((r) => `${r.modulo ?? 'fuera'}\t${r.ruta}\t${r.archivo}`)
        .join('\n'),
    );
  }

  it('encuentra las rutas, también las de los archivos con varios controllers', () => {
    expect(rutas.length).toBeGreaterThan(500);
    expect(rutas.map((r) => r.ruta)).toContain(
      'GET /v2/cylinder-recovery/cases',
    );
  });

  it('las rutas atadas a un módulo son exactamente las revisadas', () => {
    const atadas = Object.fromEntries(
      rutas
        .filter((r): r is Ruta & { modulo: string } => !!r.modulo)
        .map((r) => [r.ruta, r.modulo]),
    );
    expect(ordenar(atadas)).toEqual(ordenar(ATADAS));
  });

  it('en las carpetas de módulos, lo que no está atado es una excepción revisada con su motivo', () => {
    const sueltas = Object.fromEntries(
      deCarpetas
        .filter((r) => !r.modulo)
        .map((r) => [r.ruta, EXCEPCIONES[r.ruta] ?? '(sin revisar)']),
    );
    expect(ordenar(sueltas)).toEqual(ordenar(EXCEPCIONES));
  });

  it('cada `@SinModulo` dice por qué', () => {
    const sinMotivo = rutas
      .filter((r) => r.modulo === null && !r.motivo?.trim())
      .map((r) => r.ruta);
    expect(sinMotivo).toEqual([]);
  });

  it('toda ruta atada documenta el 403 `MODULE_DISABLED` en Swagger, y ninguna suelta lo hace', () => {
    const sinDocumentar = rutas
      .filter((r) => r.modulo && !r.descripcion403?.includes('MODULE_DISABLED'))
      .map((r) => r.ruta);
    expect(sinDocumentar).toEqual([]);
    const dinamicas = rutas
      .filter((r) => !r.modulo && r.descripcion403?.includes('MODULE_DISABLED'))
      .map((r) => r.ruta);
    expect(dinamicas).toEqual([...DINAMICAS].sort());
  });
});
