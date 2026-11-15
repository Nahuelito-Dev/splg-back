import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';

/**
 * Catálogo de los módulos que la plataforma habilita por distribuidora
 * (DISENO-PLATAFORMA-ORIXTECH §4.2). Vive en el código, como el catálogo de
 * permisos: agregar un módulo es agregarlo acá y regenerar el CHECK de
 * `distributor_module.module_key` y `platform_plan_module.module_key` en una
 * migración (`CHECK_MODULO_CONOCIDO`).
 *
 * Todo lo que no está acá (el despacho M1, pedidos, caja, flota, personal…) es
 * núcleo y no se apaga.
 */
export const MODULOS = [
  'document_reading',
  'route_planning',
  'route_batching',
  'repurchase',
  'cylinder_recovery',
  'fleet_planner',
  'whatsapp',
  'mercadopago',
  'express',
  'chat',
  'assistant',
] as const;

export type ModuloKey = (typeof MODULOS)[number];

/**
 * La llave de la empresa (el «encendido», §2): el interruptor que la propia
 * distribuidora prende y apaga.
 *  - `proceso`: el `enabled` (0/1) de ese proceso de `module_config`.
 *  - `express`: el `enabled` de los parámetros de la compra express.
 *  - `null`: el módulo no tiene interruptor de la empresa (habilitado = encendido).
 */
export type LlaveDeEmpresa =
  | {
      tipo: 'proceso';
      proceso:
        | ConfigurableProcess.DOCUMENT_READING
        | ConfigurableProcess.ROUTE_PLANNING
        | ConfigurableProcess.ROUTE_BATCHING
        | ConfigurableProcess.REPURCHASE
        | ConfigurableProcess.CYLINDER_RECOVERY;
    }
  | { tipo: 'express' }
  | null;

export interface ModuloDelCatalogo {
  key: ModuloKey;
  /** Nombre que ve la persona (panel y avisos). */
  label: string;
  llaveDeEmpresa: LlaveDeEmpresa;
  /** Qué pasa con lo que está en curso al apagarlo (§7.3), para la confirmación. */
  alApagar: string;
}

export const CATALOGO_DE_MODULOS: Readonly<
  Record<ModuloKey, ModuloDelCatalogo>
> = {
  document_reading: {
    key: 'document_reading',
    label: 'Lector de documentos',
    llaveDeEmpresa: {
      tipo: 'proceso',
      proceso: ConfigurableProcess.DOCUMENT_READING,
    },
    alApagar:
      'Los documentos que esperan lectura no se leen y quedan pendientes; subir documentos sigue funcionando.',
  },
  route_planning: {
    key: 'route_planning',
    label: 'Hoja de ruta',
    llaveDeEmpresa: {
      tipo: 'proceso',
      proceso: ConfigurableProcess.ROUTE_PLANNING,
    },
    alApagar:
      'Las hojas en curso se terminan; no se planifica el día siguiente.',
  },
  route_batching: {
    key: 'route_batching',
    label: 'Agrupación por recorrido',
    llaveDeEmpresa: {
      tipo: 'proceso',
      proceso: ConfigurableProcess.ROUTE_BATCHING,
    },
    alApagar:
      'Los lotes ya ofrecidos terminan; los pedidos nuevos se despachan de a uno.',
  },
  repurchase: {
    key: 'repurchase',
    label: 'Recompra anticipada',
    llaveDeEmpresa: {
      tipo: 'proceso',
      proceso: ConfigurableProcess.REPURCHASE,
    },
    alApagar:
      'Las invitaciones vigentes vencen solas; no se crean invitaciones nuevas.',
  },
  cylinder_recovery: {
    key: 'cylinder_recovery',
    label: 'Recupero de envases',
    llaveDeEmpresa: {
      tipo: 'proceso',
      proceso: ConfigurableProcess.CYLINDER_RECOVERY,
    },
    alApagar:
      'Las ofertas de retiro vigentes siguen; no se abren casos ni se escalan.',
  },
  fleet_planner: {
    key: 'fleet_planner',
    label: 'Planificador de taller',
    llaveDeEmpresa: null,
    alApagar:
      'Las propuestas de taller pendientes vencen solas; no se generan nuevas.',
  },
  whatsapp: {
    key: 'whatsapp',
    label: 'Venta por WhatsApp',
    llaveDeEmpresa: null,
    alApagar: 'Las conversaciones abiertas se cierran con un mensaje fijo.',
  },
  mercadopago: {
    key: 'mercadopago',
    label: 'Cobro con Mercado Pago',
    llaveDeEmpresa: null,
    alApagar:
      'Mercado Pago sale de los medios de pago; los pedidos sin pagar siguen su vencimiento y los avisos de pago y los reintegros siguen.',
  },
  express: {
    key: 'express',
    label: 'Compra express',
    llaveDeEmpresa: { tipo: 'express' },
    alApagar: 'Deja de ofrecerse; las compras express en curso terminan.',
  },
  chat: {
    key: 'chat',
    label: 'Mensajes con clientes y choferes',
    llaveDeEmpresa: null,
    alApagar:
      'La bandeja de mensajes con clientes y choferes deja de estar disponible; el chat de ayuda y los tickets siguen.',
  },
  assistant: {
    key: 'assistant',
    label: 'Asistente del chat',
    llaveDeEmpresa: null,
    alApagar:
      'El asistente deja de responder y su base de conocimiento queda guardada pero no se puede consultar ni editar; el chat sigue con el equipo.',
  },
};

export function esModulo(valor: string): valor is ModuloKey {
  return (MODULOS as readonly string[]).includes(valor);
}

/** El CHECK de la base que acota la clave de módulo a la lista del catálogo. */
export function checkModuloConocido(columna: string): string {
  return `"${columna}" IN (${MODULOS.map((m) => `'${m}'`).join(', ')})`;
}

/**
 * Módulos que ningún plan trae (apagados por omisión): la plataforma los
 * habilita empresa por empresa con una excepción (`distributor_module`).
 * El asistente del chat (M8, DISENO-CH-BOT §9 D-B3) es el primero.
 */
export const MODULOS_APAGADOS_POR_OMISION: readonly ModuloKey[] = ['assistant'];

const EN_LOS_PLANES = MODULOS.filter(
  (m) => !MODULOS_APAGADOS_POR_OMISION.includes(m),
);

/** Los planes sembrados (D-P1; `chat` en Completo y Prueba, D-C16): sus módulos. */
export const MODULOS_POR_PLAN: Readonly<
  Record<'trial' | 'basic' | 'full', readonly ModuloKey[]>
> = {
  trial: EN_LOS_PLANES,
  basic: ['mercadopago', 'express'],
  full: EN_LOS_PLANES,
};
