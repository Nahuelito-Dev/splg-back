import {
  ESQUEMAS,
  PROCESOS_AUTOMATICOS,
  esProcesoAutomatico,
  sonLosDeOmision,
  validarParametros,
  valoresDesde,
  valoresPorOmision,
} from './process-config';
import { ConfigurableProcess } from './entities/module-config.entity';

const REPURCHASE = ESQUEMAS[ConfigurableProcess.REPURCHASE];
const EXPRESS = ESQUEMAS[ConfigurableProcess.EXPRESS_DISPATCH];

describe('process-config', () => {
  it('son cinco procesos y el despacho, las tareas y el control de stock no están', () => {
    expect([...PROCESOS_AUTOMATICOS].sort()).toEqual([
      'cylinder_recovery',
      'express_dispatch',
      'fleet_planner',
      'repurchase',
      'route_batching',
    ]);
    expect(esProcesoAutomatico('dispatch')).toBe(false);
    expect(esProcesoAutomatico('scheduled_tasks')).toBe(false);
    expect(esProcesoAutomatico('stock_control')).toBe(false);
  });

  it.each(PROCESOS_AUTOMATICOS)(
    '%s: los valores por omisión caen dentro de su propio rango',
    (proceso) => {
      const esquema = ESQUEMAS[proceso];
      expect(validarParametros(esquema, valoresPorOmision(esquema))).toEqual(
        [],
      );
    },
  );

  describe('validarParametros', () => {
    it('acepta un cuerpo vacío y un subconjunto de campos', () => {
      expect(validarParametros(REPURCHASE, {})).toEqual([]);
      expect(validarParametros(REPURCHASE, { anticipationDays: 5 })).toEqual(
        [],
      );
    });

    it('rechaza un campo desconocido', () => {
      expect(validarParametros(REPURCHASE, { invento: 1 })).toEqual([
        'property invento should not exist',
      ]);
    });

    it('rechaza un valor fuera de rango y nombra el campo', () => {
      expect(validarParametros(REPURCHASE, { anticipationDays: 31 })).toEqual([
        'anticipationDays: tiene que ser un entero entre 1 y 30',
      ]);
      expect(
        validarParametros(REPURCHASE, { anticipationDays: 0 }),
      ).toHaveLength(1);
    });

    it('rechaza un decimal en un campo entero, un texto y un NaN', () => {
      expect(
        validarParametros(REPURCHASE, { anticipationDays: 2.5 }),
      ).toHaveLength(1);
      expect(
        validarParametros(REPURCHASE, { anticipationDays: '3' }),
      ).toHaveLength(1);
      expect(
        validarParametros(REPURCHASE, { anticipationDays: NaN }),
      ).toHaveLength(1);
      expect(
        validarParametros(REPURCHASE, { anticipationDays: null }),
      ).toHaveLength(1);
    });

    it('acepta decimales donde el campo es numérico', () => {
      expect(validarParametros(EXPRESS, { maxRadiusKm: 2.5 })).toEqual([]);
    });

    it('rechaza un cuerpo que no es un objeto', () => {
      expect(validarParametros(REPURCHASE, null)).toHaveLength(1);
      expect(validarParametros(REPURCHASE, [1, 2])).toHaveLength(1);
      expect(validarParametros(REPURCHASE, 'x')).toHaveLength(1);
    });

    it('express: el fin del horario tiene que ser posterior al inicio, contando lo no enviado', () => {
      expect(
        validarParametros(EXPRESS, {
          serviceStartHour: 10,
          serviceEndHour: 10,
        }),
      ).toEqual(['serviceEndHour: tiene que ser posterior a serviceStartHour']);
      // Sólo el inicio: queda contra el fin por omisión (20).
      expect(validarParametros(EXPRESS, { serviceStartHour: 21 })).toHaveLength(
        1,
      );
      expect(
        validarParametros(EXPRESS, { serviceStartHour: 9, serviceEndHour: 18 }),
      ).toEqual([]);
    });
  });

  describe('valoresDesde', () => {
    it('sin configuración devuelve los de omisión', () => {
      expect(valoresDesde(REPURCHASE, null)).toEqual(
        valoresPorOmision(REPURCHASE),
      );
    });

    it('mezcla lo guardado con los de omisión', () => {
      const v = valoresDesde(REPURCHASE, { anticipationDays: 7 });
      expect(v.anticipationDays).toBe(7);
      expect(v.minOrders).toBe(3);
    });

    it('un valor guardado inválido cae al de omisión', () => {
      expect(
        valoresDesde(REPURCHASE, { anticipationDays: 999 }).anticipationDays,
      ).toBe(3);
    });

    it('un horario guardado incoherente vuelve a los de omisión', () => {
      const v = valoresDesde(EXPRESS, {
        serviceStartHour: 22,
        serviceEndHour: 21,
      });
      expect(v.serviceStartHour).toBe(8);
      expect(v.serviceEndHour).toBe(20);
    });
  });

  it('sonLosDeOmision', () => {
    expect(sonLosDeOmision(REPURCHASE, valoresPorOmision(REPURCHASE))).toBe(
      true,
    );
    expect(
      sonLosDeOmision(REPURCHASE, {
        ...valoresPorOmision(REPURCHASE),
        minOrders: 4,
      }),
    ).toBe(false);
  });
});
