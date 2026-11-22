import {
  ESQUEMAS,
  PROCESOS_AUTOMATICOS,
  esProcesoAutomatico,
  sonLosDeOmision,
  validarParametros,
  valoresDesde,
  valoresPorOmision,
} from './process-config';
import { getMetadataArgsStorage } from 'typeorm';
import {
  ConfigurableProcess,
  ModuleConfig,
} from './entities/module-config.entity';

const REPURCHASE = ESQUEMAS[ConfigurableProcess.REPURCHASE];
/** Un proceso con un campo decimal (`number`), para probar que acepta decimales. */
const CON_DECIMAL = Object.values(ESQUEMAS).find((e) =>
  e.fields.some((c) => c.type === 'number'),
)!;
const CAMPO_DECIMAL = CON_DECIMAL.fields.find((c) => c.type === 'number')!;

describe('process-config', () => {
  describe('hoja de ruta (route_planning)', () => {
    const HOJA = ESQUEMAS[ConfigurableProcess.ROUTE_PLANNING];

    it('viene encendida, cierra a las 18:00, propone sola y confirma sola a la hora', () => {
      const v = valoresPorOmision(HOJA);
      expect(v).toMatchObject({
        enabled: 1,
        cutoffHour: 18,
        cutoffMinute: 0,
        autoPropose: 1,
        autoConfirm: 1,
        reviewMinutes: 60,
        maxStopsPerSheet: 20,
        serviceMinutes: 10,
        trafficFactor: 1.2,
        etaWindowMinutes: 30,
        lateOrderPolicy: 1,
        notStartedAlertMinutes: 30,
      });
    });

    it('la distribuidora que guardó enabled conserva su valor; la que no lo guardó la tiene encendida', () => {
      expect(valoresDesde(HOJA, { enabled: 0 }).enabled).toBe(0);
      expect(valoresDesde(HOJA, { cutoffHour: 20 }).enabled).toBe(1);
      expect(valoresDesde(HOJA, null).enabled).toBe(1);
    });

    it('autoConfirm 0–1 y reviewMinutes 0–720 enteros', () => {
      expect(
        validarParametros(HOJA, { autoConfirm: 0, reviewMinutes: 0 }),
      ).toEqual([]);
      expect(validarParametros(HOJA, { reviewMinutes: 720 })).toEqual([]);
      expect(validarParametros(HOJA, { reviewMinutes: 721 })).toHaveLength(1);
      expect(validarParametros(HOJA, { reviewMinutes: -1 })).toHaveLength(1);
      expect(validarParametros(HOJA, { reviewMinutes: 1.5 })).toHaveLength(1);
      expect(validarParametros(HOJA, { autoConfirm: 2 })).toHaveLength(1);
    });

    it('el factor de tránsito admite decimales; el resto son enteros', () => {
      expect(validarParametros(HOJA, { trafficFactor: 1.35 })).toEqual([]);
      expect(validarParametros(HOJA, { serviceMinutes: 7.5 })).toHaveLength(1);
      expect(validarParametros(HOJA, { cutoffHour: 24 })).toHaveLength(1);
      expect(validarParametros(HOJA, { trafficFactor: 0.9 })).toHaveLength(1);
      expect(validarParametros(HOJA, { maxStopsPerSheet: 41 })).toHaveLength(1);
    });

    it('el CHECK de la base tiene los mismos campos y rangos que el esquema', () => {
      const check = getMetadataArgsStorage().checks.find(
        (c) =>
          c.target === ModuleConfig &&
          c.name === 'CHK_module_config_hoja_de_ruta',
      );
      expect(check).toBeDefined();
      const expresion = check?.expression ?? '';
      for (const c of HOJA.fields) {
        expect(expresion).toContain(
          `("params" ->> '${c.key}')::numeric BETWEEN ${c.min} AND ${c.max}`,
        );
      }
      const claves = [
        ...expresion.matchAll(/jsonb_typeof\("params" -> '(\w+)'\)/g),
      ];
      expect(claves.map((m) => m[1]).sort()).toEqual(
        HOJA.fields.map((c) => c.key).sort(),
      );
    });
  });

  describe('recuperación de envases (CU-108)', () => {
    const RECUPERO = ESQUEMAS[ConfigurableProcess.CYLINDER_RECOVERY];

    it('trae tolerancia, plazo del escalón, umbral, vigencia de la oferta, ventana de entrega, hora e interruptor', () => {
      expect(RECUPERO.fields.map((f) => f.key)).toEqual([
        'toleranceDays',
        'escalationStepDays',
        'escalationAmountThreshold',
        'pickupOfferTtlHours',
        'pickupWindowDays',
        'runHour',
        'enabled',
      ]);
    });

    it('el umbral admite decimales; el resto son enteros', () => {
      expect(
        validarParametros(RECUPERO, { escalationAmountThreshold: 1234.5 }),
      ).toEqual([]);
      expect(validarParametros(RECUPERO, { toleranceDays: 1.5 })).toHaveLength(
        1,
      );
    });

    it('arranca apagado y a media mañana', () => {
      const porOmision = valoresPorOmision(RECUPERO);
      expect(porOmision.enabled).toBe(0);
      expect(porOmision.runHour).toBe(10);
      expect(validarParametros(RECUPERO, { enabled: 2 })).toHaveLength(1);
    });

    it('rechaza lo que está fuera de rango', () => {
      expect(
        validarParametros(RECUPERO, { toleranceDays: 0, runHour: 24 }),
      ).toHaveLength(2);
      expect(
        validarParametros(RECUPERO, { pickupWindowDays: 61 }),
      ).toHaveLength(1);
    });
  });

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

    it('lleva la autocalibración: promedia 5 cierres y corrige hasta 14 días, con topes validados', () => {
      const por = (k: string) => PLANIFICADOR.fields.find((f) => f.key === k);
      expect(por('calibrationClosures')).toMatchObject({
        default: 5,
        min: 3,
        max: 20,
      });
      expect(por('calibrationMaxDays')).toMatchObject({
        default: 14,
        min: 0,
        max: 60,
      });
      expect(
        validarParametros(PLANIFICADOR, { calibrationClosures: 2 }),
      ).toHaveLength(1);
      expect(
        validarParametros(PLANIFICADOR, { calibrationMaxDays: 61 }),
      ).toHaveLength(1);
      expect(
        validarParametros(PLANIFICADOR, { calibrationMaxDays: 0 }),
      ).toHaveLength(0);
    });

    it('el taller tiene que empezar antes de terminar', () => {
      expect(
        validarParametros(PLANIFICADOR, {
          workshopStartHour: 14,
          workshopEndHour: 12,
        }),
      ).toEqual([
        'Hora de apertura del taller: tiene que ser anterior a la hora de cierre',
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

  it('son seis procesos; el despacho, las tareas, el express y el control de stock no están', () => {
    expect([...PROCESOS_AUTOMATICOS].sort()).toEqual([
      'cylinder_recovery',
      'document_reading',
      'fleet_planner',
      'repurchase',
      'route_batching',
      'route_planning',
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
        'Se envió un dato que no corresponde',
      ]);
    });

    it('rechaza un valor fuera de rango y nombra el campo', () => {
      expect(validarParametros(REPURCHASE, { anticipationDays: 31 })).toEqual([
        'Días de anticipación: tiene que ser un entero entre 1 y 30',
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

  describe('recompra anticipada (CU-106): interruptor y horario', () => {
    it('viene apagada: enabled vale 0 por omisión y sólo admite 0 o 1', () => {
      expect(valoresPorOmision(REPURCHASE).enabled).toBe(0);
      expect(validarParametros(REPURCHASE, { enabled: 1 })).toEqual([]);
      expect(validarParametros(REPURCHASE, { enabled: 2 })).toHaveLength(1);
      expect(validarParametros(REPURCHASE, { enabled: 0.5 })).toHaveLength(1);
    });

    it('la hora de ejecución es diurna: de 8 a 21', () => {
      expect(validarParametros(REPURCHASE, { runHour: 8 })).toEqual([]);
      expect(validarParametros(REPURCHASE, { runHour: 21 })).toEqual([]);
      expect(validarParametros(REPURCHASE, { runHour: 7 })).toHaveLength(1);
      expect(validarParametros(REPURCHASE, { runHour: 22 })).toHaveLength(1);
      expect(validarParametros(REPURCHASE, { runHour: 3 })).toHaveLength(1);
    });
  });
});
