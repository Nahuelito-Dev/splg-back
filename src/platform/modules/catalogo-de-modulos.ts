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
};

export function esModulo(valor: string): valor is ModuloKey {
  return (MODULOS as readonly string[]).includes(valor);
}

/** El CHECK de la base que acota la clave de módulo a la lista del catálogo. */
export function checkModuloConocido(columna: string): string {
  return `"${columna}" IN (${MODULOS.map((m) => `'${m}'`).join(', ')})`;
}

/** Los planes sembrados (D-P1): sus módulos. */
export const MODULOS_POR_PLAN: Readonly<
  Record<'trial' | 'basic' | 'full', readonly ModuloKey[]>
> = {
  trial: MODULOS,
  basic: ['mercadopago', 'express'],
  full: MODULOS,
};
