import { ConfigurableProcess } from './entities/module-config.entity';

/**
 * Esquema de los procesos automáticos configurables (CU-172). Cada proceso trae
 * sus campos con rango y valor por omisión: los parámetros de `module_config`
 * son JSON y no se validan solos, así que un parámetro mal escrito se rechaza
 * en lugar de guardarse. Los valores por omisión son los que regirían si la
 * distribuidora no configura nada.
 *
 * `dispatch` (CU-171) y `scheduled_tasks` (CU-173) tienen su propio servicio y
 * su propia ruta; `stock_control` no es un proceso automático.
 */
export type TipoDeCampo = 'integer' | 'number';

export interface CampoDeProceso {
  key: string;
  type: TipoDeCampo;
  min: number;
  max: number;
  default: number;
  /** Unidad para mostrar (h, min, km, $...); sólo informativa. */
  unit: string | null;
  description: string;
}

export interface EsquemaDeProceso {
  process: ProcesoAutomatico;
  title: string;
  description: string;
  fields: CampoDeProceso[];
  /** Regla que cruza campos; devuelve el mensaje de error o `null`. */
  cruzada?: (valores: Record<string, number>) => string | null;
}

/**
 * Los procesos que edita CU-172 por esta vía genérica. El despacho express
 * tiene su propia ruta y su propio servicio (`/module-config/express_dispatch`,
 * `ExpressSettingsService`), que es el que lee la compra express.
 */
export const PROCESOS_AUTOMATICOS = [
  ConfigurableProcess.FLEET_PLANNER,
  ConfigurableProcess.REPURCHASE,
  ConfigurableProcess.ROUTE_BATCHING,
  ConfigurableProcess.CYLINDER_RECOVERY,
] as const;

export type ProcesoAutomatico = (typeof PROCESOS_AUTOMATICOS)[number];

export function esProcesoAutomatico(valor: string): valor is ProcesoAutomatico {
  return (PROCESOS_AUTOMATICOS as readonly string[]).includes(valor);
}

const campo = (
  key: string,
  type: TipoDeCampo,
  min: number,
  max: number,
  porDefecto: number,
  unit: string | null,
  description: string,
): CampoDeProceso => ({
  key,
  type,
  min,
  max,
  default: porDefecto,
  unit,
  description,
});

export const ESQUEMAS: Record<ProcesoAutomatico, EsquemaDeProceso> = {
  [ConfigurableProcess.FLEET_PLANNER]: {
    process: ConfigurableProcess.FLEET_PLANNER,
    title: 'Planificador de flota',
    description:
      'Anticipa los vencimientos y el mantenimiento de la flota y propone ventanas de taller (CU-105).',
    fields: [
      campo(
        'cronHour',
        'integer',
        0,
        23,
        3,
        'h',
        'Hora de ejecución diaria (hora de Argentina)',
      ),
      campo(
        'proposalTtlHours',
        'integer',
        1,
        168,
        24,
        'h',
        'Vigencia de la propuesta de ventana enviada al chofer',
      ),
      campo(
        'topNWindows',
        'integer',
        1,
        10,
        3,
        null,
        'Ventanas alternativas que se ofrecen antes de escalar al administrador',
      ),
      campo(
        'minVehiclesPerZone',
        'integer',
        0,
        100,
        1,
        null,
        'Mínimo operativo de vehículos por zona de cobertura',
      ),
      campo(
        'minSampleDays',
        'integer',
        1,
        365,
        10,
        'días',
        'Días CON registro de uso exigidos antes de confiar en la predicción propia',
      ),
      campo(
        'decay',
        'number',
        0,
        1,
        0.7,
        null,
        'Peso relativo de las semanas recientes en la media móvil',
      ),
      campo(
        'horizonDays',
        'integer',
        1,
        180,
        30,
        'días',
        'Hasta cuántos días hacia adelante se buscan ventanas de taller',
      ),
      campo(
        'minLeadDays',
        'integer',
        0,
        30,
        1,
        'días',
        'Días de aviso mínimos entre la propuesta y la ventana de taller',
      ),
      campo(
        'zoneLookbackDays',
        'integer',
        1,
        90,
        14,
        'días',
        'Días hacia atrás en que se mira dónde entregó el vehículo para derivar su zona',
      ),
      campo(
        'demandWeeks',
        'integer',
        1,
        26,
        8,
        'semanas',
        'Semanas de pedidos entregados que se toman para estimar la demanda de cada día',
      ),
      campo(
        'workshopStartHour',
        'integer',
        0,
        23,
        8,
        'h',
        'Hora en que empieza la ventana de taller (hora de Argentina)',
      ),
      campo(
        'workshopEndHour',
        'integer',
        1,
        24,
        13,
        'h',
        'Hora en que termina la ventana de taller (hora de Argentina)',
      ),
      campo(
        'workshopDays',
        'integer',
        1,
        127,
        126,
        null,
        'Días de la semana en que atiende el taller (suma de 1 domingo, 2 lunes, 4 martes, 8 miércoles, 16 jueves, 32 viernes y 64 sábado)',
      ),
      campo(
        'usageStaleDays',
        'integer',
        1,
        90,
        14,
        'días',
        'Si el último registro de uso es más viejo, los datos se consideran desactualizados y no se proyecta con ellos',
      ),
      campo(
        'anticipationKm',
        'integer',
        0,
        1_000_000,
        0,
        'km',
        'Además de la anticipación en días del plan, se planifica cuando faltan estos kilómetros (0 la desactiva)',
      ),
      campo(
        'driverEmail',
        'integer',
        0,
        1,
        0,
        null,
        'Mandar también un correo al chofer cuando se le propone una ventana (0 no, 1 sí)',
      ),
    ],
    cruzada: (v) =>
      v.workshopStartHour >= v.workshopEndHour
        ? 'workshopStartHour: tiene que ser anterior a workshopEndHour'
        : null,
  },
  [ConfigurableProcess.REPURCHASE]: {
    process: ConfigurableProcess.REPURCHASE,
    title: 'Anticipación de recompra',
    description:
      'Estima cuándo se le acaba la garrafa a cada cliente y le ofrece reponer (CU-106).',
    fields: [
      campo(
        'minOrders',
        'integer',
        2,
        50,
        3,
        null,
        'Pedidos mínimos en el historial para estimar el consumo',
      ),
      campo(
        'anticipationDays',
        'integer',
        1,
        30,
        3,
        'días',
        'Anticipación con que se envía la invitación a reponer',
      ),
      campo(
        'invitationTtlHours',
        'integer',
        1,
        168,
        24,
        'h',
        'Vigencia de la invitación',
      ),
      campo(
        'minIntervalDays',
        'integer',
        1,
        90,
        7,
        'días',
        'Intervalo mínimo antes de volver a invitar al mismo cliente',
      ),
      campo(
        'runHour',
        'integer',
        0,
        23,
        9,
        'h',
        'Hora de ejecución diaria (hora de Argentina)',
      ),
    ],
  },
  [ConfigurableProcess.ROUTE_BATCHING]: {
    process: ConfigurableProcess.ROUTE_BATCHING,
    title: 'Agrupación por recorrido',
    description:
      'Agrupa pedidos programados cercanos en un lote para ofrecérselo a un mismo chofer (CU-107).',
    fields: [
      campo(
        'maxBatchSize',
        'integer',
        2,
        20,
        4,
        null,
        'Pedidos máximos por lote',
      ),
      campo(
        'groupingRadiusKm',
        'number',
        0.5,
        50,
        3,
        'km',
        'Radio dentro del cual se agrupan los pedidos',
      ),
      campo(
        'slotToleranceMinutes',
        'integer',
        0,
        480,
        60,
        'min',
        'Tolerancia entre las franjas horarias de los pedidos de un lote',
      ),
      campo(
        'offerTtlSeconds',
        'integer',
        10,
        600,
        60,
        's',
        'Vigencia de la oferta del lote al chofer',
      ),
      campo(
        'evaluationFrequencyMinutes',
        'integer',
        1,
        1440,
        15,
        'min',
        'Cada cuánto se evalúan los pedidos para armar lotes',
      ),
    ],
  },
  [ConfigurableProcess.CYLINDER_RECOVERY]: {
    process: ConfigurableProcess.CYLINDER_RECOVERY,
    title: 'Recuperación de envases',
    description:
      'Detecta los envases retenidos por clientes y escala los avisos hasta recuperarlos (CU-108).',
    fields: [
      campo(
        'toleranceDays',
        'integer',
        1,
        365,
        30,
        'días',
        'Plazo de tolerancia de devolución antes de abrir un caso',
      ),
      campo(
        'escalationStepDays',
        'integer',
        1,
        90,
        7,
        'días',
        'Plazo de cada escalón de aviso',
      ),
      campo(
        'escalationAmountThreshold',
        'number',
        0,
        100_000_000,
        50_000,
        '$',
        'Importe de depósito desde el cual el caso escala',
      ),
      campo(
        'pickupOfferTtlHours',
        'integer',
        1,
        720,
        72,
        'h',
        'Vigencia de la oferta de retiro',
      ),
    ],
  },
};

export type ValoresDeProceso = Record<string, number>;

export function valoresPorOmision(esquema: EsquemaDeProceso): ValoresDeProceso {
  return Object.fromEntries(esquema.fields.map((f) => [f.key, f.default]));
}

function valorValido(c: CampoDeProceso, valor: unknown): valor is number {
  return (
    typeof valor === 'number' &&
    Number.isFinite(valor) &&
    valor >= c.min &&
    valor <= c.max &&
    (c.type === 'number' || Number.isInteger(valor))
  );
}

/**
 * Valida el cuerpo de un `PUT` contra el esquema: sólo campos conocidos, cada
 * uno del tipo y dentro de su rango, y las reglas que cruzan campos sobre los
 * valores que quedarían (lo no enviado cuenta con su valor por omisión).
 * Devuelve los mensajes de error (vacío si es válido).
 */
export function validarParametros(
  esquema: EsquemaDeProceso,
  cuerpo: unknown,
): string[] {
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
    return ['El cuerpo tiene que ser un objeto con los parámetros del proceso'];
  }
  const errores: string[] = [];
  const recibido = cuerpo as Record<string, unknown>;
  const conocidos = new Map(esquema.fields.map((f) => [f.key, f]));

  for (const [clave, valor] of Object.entries(recibido)) {
    const c = conocidos.get(clave);
    if (!c) {
      errores.push(`property ${clave} should not exist`);
    } else if (!valorValido(c, valor)) {
      const tipo = c.type === 'integer' ? 'un entero' : 'un número';
      errores.push(`${clave}: tiene que ser ${tipo} entre ${c.min} y ${c.max}`);
    }
  }
  if (errores.length > 0) return errores;

  if (esquema.cruzada) {
    const efectivos = {
      ...valoresPorOmision(esquema),
      ...recibido,
    } as ValoresDeProceso;
    const mensaje = esquema.cruzada(efectivos);
    if (mensaje) errores.push(mensaje);
  }
  return errores;
}

/**
 * Los parámetros guardados, leídos con defensa: un valor ausente o fuera de
 * rango cae al de omisión en vez de romper el proceso que lo consume.
 */
export function valoresDesde(
  esquema: EsquemaDeProceso,
  params: Record<string, unknown> | null,
): ValoresDeProceso {
  const base = valoresPorOmision(esquema);
  if (!params) return base;
  for (const c of esquema.fields) {
    const v = params[c.key];
    if (valorValido(c, v)) base[c.key] = v;
  }
  if (esquema.cruzada?.(base)) return valoresPorOmision(esquema);
  return base;
}

export function sonLosDeOmision(
  esquema: EsquemaDeProceso,
  valores: ValoresDeProceso,
): boolean {
  return esquema.fields.every((f) => valores[f.key] === f.default);
}
