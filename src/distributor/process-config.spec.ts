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
/** Un proceso con un campo decimal (`number`), para probar que acepta decimales. */
const CON_DECIMAL = Object.values(ESQUEMAS).find((e) =>
  e.fields.some((c) => c.type === 'number'),
)!;
const CAMPO_DECIMAL = CON_DECIMAL.fields.find((c) => c.type === 'number')!;

describe('process-config', () => {
  describe('planificador de flota (CU-105)', () => {
    const PLANIFICADOR = ESQUEMAS[ConfigurableProcess.FLEET_PLANNER];

    it('lleva los parámetros del planificador de taller', () => {
      expect(PLANIFICADOR.fields.map((f) => f.key)).toEqual(
        expect.arrayContaining([
          'horizonDays',
          'minLeadDays',
          'zoneLookbackDays',
          'demandWeeks',
          'workshopStartHour',
          'workshopEndHour',
        ]),
      );
    });

    it('los días de taller son una máscara de 1 a 127, lunes a sábado por omisión', () => {
      const campo = PLANIFICADOR.fields.find((f) => f.key === 'workshopDays');
      expect(campo).toMatchObject({ min: 1, max: 127, default: 126 });
      expect(validarParametros(PLANIFICADOR, { workshopDays: 0 })).toHaveLength(
        1,
      );
      expect(
        validarParametros(PLANIFICADOR, { workshopDays: 128 }),
      ).toHaveLength(1);
      expect(validarParametros(PLANIFICADOR, { workshopDays: 127 })).toEqual(
        [],
      );
    });

    it('lleva la tolerancia de datos viejos, la anticipación por km y el correo al chofer (apagado por omisión)', () => {
      const por = (k: string) => PLANIFICADOR.fields.find((f) => f.key === k);
      expect(por('usageStaleDays')?.default).toBe(14);
      expect(por('anticipationKm')?.default).toBe(0);
      expect(por('driverEmail')).toMatchObject({ default: 0, min: 0, max: 1 });
      expect(validarParametros(PLANIFICADOR, { driverEmail: 2 })).toHaveLength(
        1,
      );
      expect(
        validarParametros(PLANIFICADOR, { driverEmail: 0.5 }),
      ).toHaveLength(1);
    });

    it('el taller tiene que empezar antes de terminar', () => {
      expect(
        validarParametros(PLANIFICADOR, {
          workshopStartHour: 14,
          workshopEndHour: 12,
        }),
      ).toEqual([
        'workshopStartHour: tiene que ser anterior a workshopEndHour',
      ]);
      expect(
        validarParametros(PLANIFICADOR, {
          workshopStartHour: 9,
          workshopEndHour: 17,
        }),
      ).toEqual([]);
    });

    it('la regla cruzada cuenta los valores por omisión del que no viene', () => {
      // El fin por omisión es 13: un inicio a las 15 lo contradice.
      expect(
        validarParametros(PLANIFICADOR, { workshopStartHour: 15 }),
      ).toHaveLength(1);
    });

    it('valoresDesde descarta una combinación guardada incoherente', () => {
      const v = valoresDesde(PLANIFICADOR, { workshopStartHour: 15 });
      expect(v).toEqual(valoresPorOmision(PLANIFICADOR));
    });
  });

  it('son cuatro procesos; el despacho, las tareas, el express y el control de stock no están', () => {
    expect([...PROCESOS_AUTOMATICOS].sort()).toEqual([
      'cylinder_recovery',
      'fleet_planner',
      'repurchase',
      'route_batching',
    ]);
    expect(esProcesoAutomatico('dispatch')).toBe(false);
    expect(esProcesoAutomatico('scheduled_tasks')).toBe(false);
    expect(esProcesoAutomatico('stock_control')).toBe(false);
    // El express tiene su propia ruta y servicio (ExpressSettingsService).
    expect(esProcesoAutomatico('express_dispatch')).toBe(false);
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
      const valor = (CAMPO_DECIMAL.min + CAMPO_DECIMAL.max) / 2 + 0.05;
      expect(
        validarParametros(CON_DECIMAL, { [CAMPO_DECIMAL.key]: valor }),
      ).toEqual([]);
    });

    it('rechaza un cuerpo que no es un objeto', () => {
      expect(validarParametros(REPURCHASE, null)).toHaveLength(1);
      expect(validarParametros(REPURCHASE, [1, 2])).toHaveLength(1);
      expect(validarParametros(REPURCHASE, 'x')).toHaveLength(1);
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
