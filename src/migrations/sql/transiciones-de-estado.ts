/**
 * Triggers de transición de estado. Los crea la migración `TransicionesDeEstado`
 * y también el arranque de la base de las pruebas de integración (el esquema
 * sincronizado desde las entidades no trae triggers).
 *
 * Las tablas de abajo son una COPIA CONGELADA de las máquinas de estado del
 * dominio (una migración no puede depender de código que cambia después);
 * `transiciones-de-estado.spec.ts` verifica que coinciden con las constantes del
 * dominio, así que un cambio en una máquina sin su migración rompe un test.
 *
 * Un UPDATE que salte una transición inválida falla con SQLSTATE 23514 y la
 * restricción `CHK_<tabla>_transicion_de_estado`; `traducirErrorDeBase` la
 * traduce a 409. Repetir el mismo estado no es una transición y pasa.
 *
 * Bypass explícito, sólo para seeds y fixtures de prueba que necesitan escribir
 * un estado directo: `SET LOCAL splg.bypass_transiciones = on` dentro de la
 * transacción (el trigger lo lee con `current_setting`). El back no lo usa.
 */
export interface MaquinaDeEstado {
  tabla: string;
  columna: string;
  /** Cómo se nombra en el mensaje: «El pedido no puede pasar de A a B». */
  etiqueta: string;
  transiciones: Readonly<Record<string, readonly string[]>>;
}

export const MAQUINAS_DE_ESTADO: readonly MaquinaDeEstado[] = [
  {
    tabla: 'order',
    columna: 'status',
    etiqueta: 'El pedido',
    transiciones: {
      reserved: ['pending', 'cancelled'],
      pending: ['accepted', 'cancelled'],
      accepted: ['on_the_way', 'pending', 'cancelled'],
      on_the_way: ['delivered', 'cancelled', 'pending'],
      delivered: [],
      cancelled: [],
    },
  },
  {
    tabla: 'cylinder',
    columna: 'state',
    etiqueta: 'El envase',
    transiciones: {
      in_depot: ['filled', 'retired'],
      filled: ['dispatched', 'in_depot'],
      dispatched: ['with_customer', 'in_depot'],
      with_customer: ['empty_returned', 'retired'],
      empty_returned: ['in_depot', 'retired'],
      retired: [],
    },
  },
  {
    tabla: 'driver_settlement',
    columna: 'status',
    etiqueta: 'La rendición',
    transiciones: {
      open: ['submitted'],
      submitted: ['approved', 'open'],
      approved: [],
    },
  },
  {
    tabla: 'driver_liquidation',
    columna: 'status',
    etiqueta: 'La liquidación',
    transiciones: {
      draft: ['approved', 'voided'],
      approved: ['paid', 'voided'],
      paid: ['approved'],
      voided: [],
    },
  },
  {
    tabla: 'purchase_order',
    columna: 'status',
    etiqueta: 'La orden de compra',
    transiciones: {
      draft: ['sent', 'cancelled'],
      sent: ['partially_received', 'received', 'cancelled'],
      partially_received: [
        'partially_received',
        'received',
        'sent',
        'closed_short',
      ],
      received: ['partially_received', 'sent'],
      closed_short: [],
      cancelled: [],
    },
  },
  {
    tabla: 'truck_load',
    columna: 'status',
    etiqueta: 'La carga del camión',
    transiciones: {
      loading: ['on_route', 'cancelled'],
      on_route: ['returned'],
      returned: ['closed', 'closed_with_difference'],
      closed: [],
      closed_with_difference: [],
      cancelled: [],
    },
  },
  {
    tabla: 'claims',
    columna: 'status',
    etiqueta: 'El reclamo',
    transiciones: {
      pending: ['in_process', 'resolved', 'rejected'],
      in_process: ['resolved', 'rejected'],
      resolved: ['in_process'],
      rejected: ['in_process'],
    },
  },
  {
    tabla: 'customer_account',
    columna: 'status',
    etiqueta: 'La cuenta corriente',
    transiciones: {
      active: ['blocked', 'closed'],
      blocked: ['active', 'closed'],
      closed: ['active'],
    },
  },
  {
    tabla: 'order_dispatch_offer',
    columna: 'status',
    etiqueta: 'La oferta de despacho',
    transiciones: {
      offered: ['accepted', 'rejected', 'expired', 'superseded'],
      accepted: ['rejected'],
      rejected: [],
      expired: [],
      superseded: [],
    },
  },
];

export const nombreDeLaRestriccionDeTransicion = (tabla: string): string =>
  `CHK_${tabla}_transicion_de_estado`;
export const nombreDelTriggerDeTransicion = (tabla: string): string =>
  `TRG_${tabla}_transicion_de_estado`;
export const nombreDeLaFuncionDeTransicion = (tabla: string): string =>
  `transicion_de_estado_${tabla}`;

/** Pares «desde>hacia» válidos de una máquina, ordenados para que el SQL sea estable. */
export function paresDeTransicion(m: MaquinaDeEstado): string[] {
  return Object.entries(m.transiciones)
    .flatMap(([desde, destinos]) =>
      destinos.map((hacia) => `${desde}>${hacia}`),
    )
    .sort();
}

export function crearFuncionDeTransicion(m: MaquinaDeEstado): string {
  const pares = paresDeTransicion(m)
    .map((p) => `'${p}'`)
    .join(', ');
  const col = `"${m.columna}"`;
  return `CREATE FUNCTION ${nombreDeLaFuncionDeTransicion(m.tabla)}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.${col} IS NOT DISTINCT FROM NEW.${col}
            OR current_setting('splg.bypass_transiciones', true) = 'on'
            OR (OLD.${col}::text || '>' || NEW.${col}::text) = ANY (ARRAY[${pares}]) THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION '${m.etiqueta} no puede pasar de % a %', OLD.${col}, NEW.${col}
           USING ERRCODE = '23514', CONSTRAINT = '${nombreDeLaRestriccionDeTransicion(m.tabla)}';
       END $$`;
}

export function crearTriggerDeTransicion(m: MaquinaDeEstado): string {
  return `CREATE TRIGGER "${nombreDelTriggerDeTransicion(m.tabla)}" BEFORE UPDATE OF "${m.columna}" ON "${m.tabla}"
         FOR EACH ROW EXECUTE FUNCTION ${nombreDeLaFuncionDeTransicion(m.tabla)}()`;
}

export function quitarTriggerDeTransicion(m: MaquinaDeEstado): string[] {
  return [
    `DROP TRIGGER IF EXISTS "${nombreDelTriggerDeTransicion(m.tabla)}" ON "${m.tabla}"`,
    `DROP FUNCTION IF EXISTS ${nombreDeLaFuncionDeTransicion(m.tabla)}()`,
  ];
}

/** Todas las sentencias que instalan los triggers de transición. */
export function sentenciasDeTransiciones(): string[] {
  return MAQUINAS_DE_ESTADO.flatMap((m) => [
    crearFuncionDeTransicion(m),
    crearTriggerDeTransicion(m),
  ]);
}
