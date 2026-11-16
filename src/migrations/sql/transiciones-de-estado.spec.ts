import { CLAIM_TRANSITIONS } from '../../claims/claim-status.machine';
import { TRANSICIONES_DE_LIQUIDACION } from '../../commission/domain/commission-rules';
import { TRANSICIONES_DE_CUENTA } from '../../customer-account/domain/customer-account-rules';
import { CYLINDER_TRANSITIONS } from '../../cylinder/domain/cylinder-state.machine';
import { TRANSICIONES_DE_RENDICION } from '../../driver-settlement/domain/driver-settlement-rules';
import { DISPATCH_OFFER_TRANSITIONS } from '../../order/domain/dispatch-offer-status.machine';
import { ORDER_TRANSITIONS } from '../../order/domain/order-status.machine';
import { TRANSICIONES } from '../../purchase/domain/purchase-rules';
import { TRANSICIONES_DE_CARGA } from '../../truck-load/domain/truck-load-rules';
import {
  crearFuncionDeTransicion,
  crearTriggerDeTransicion,
  MAQUINAS_DE_ESTADO,
  paresDeTransicion,
} from './transiciones-de-estado';

type Tabla = Readonly<Record<string, readonly string[]>>;

/** La fuente de verdad de cada máquina: la constante del dominio. */
const DOMINIO: Record<string, Tabla> = {
  order: ORDER_TRANSITIONS,
  cylinder: CYLINDER_TRANSITIONS,
  driver_settlement: TRANSICIONES_DE_RENDICION,
  driver_liquidation: TRANSICIONES_DE_LIQUIDACION,
  purchase_order: TRANSICIONES,
  truck_load: TRANSICIONES_DE_CARGA,
  claims: CLAIM_TRANSITIONS,
  customer_account: TRANSICIONES_DE_CUENTA,
  order_dispatch_offer: DISPATCH_OFFER_TRANSITIONS,
};

const ordenar = (t: Tabla): Record<string, string[]> =>
  Object.fromEntries(
    Object.keys(t)
      .sort()
      .map((k) => [k, [...t[k]].sort()]),
  );

describe('Triggers de transición de estado de la base', () => {
  it('cubren las nueve máquinas del dominio, ni más ni menos', () => {
    expect(MAQUINAS_DE_ESTADO.map((m) => m.tabla).sort()).toEqual(
      Object.keys(DOMINIO).sort(),
    );
  });

  it.each(MAQUINAS_DE_ESTADO.map((m) => [m.tabla, m] as const))(
    '%s: la tabla de la base es la del dominio',
    (tabla, maquina) => {
      expect(ordenar(maquina.transiciones)).toEqual(ordenar(DOMINIO[tabla]));
    },
  );

  it('el SQL generado lleva los pares del dominio, la restricción y el bypass', () => {
    for (const m of MAQUINAS_DE_ESTADO) {
      const funcion = crearFuncionDeTransicion(m);
      for (const par of paresDeTransicion(m)) {
        expect(funcion).toContain(`'${par}'`);
      }
      expect(funcion).toContain(`CHK_${m.tabla}_transicion_de_estado`);
      expect(funcion).toContain('splg.bypass_transiciones');
      expect(crearTriggerDeTransicion(m)).toContain(
        `BEFORE UPDATE OF "${m.columna}" ON "${m.tabla}"`,
      );
    }
  });
});
