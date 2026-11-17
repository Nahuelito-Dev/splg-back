import { createHash } from 'crypto';
import {
  CAUSAS_EN_CASTELLANO,
  CausaDeDerivacion,
  DERIVACIONES_SIN_IA,
  MOTIVOS_DE_DERIVACION,
  MOTIVOS_EN_CASTELLANO,
  MotivoDeDerivacion,
} from '../assistant-ai/asistente-ia.dominio';
import {
  causaDeLaTraza,
  type ResultadoDeLaPrueba,
} from '../assistant-ai/asistente-ia.service';
import {
  ESTADO_DE_MI_PEDIDO,
  HORARIOS_Y_ZONAS,
  MEDIOS_DE_PAGO,
  PRECIOS_VIGENTES,
} from '../assistant-ai/herramientas';
import { textoParaSugerir } from '../chat/domain/sugerencias';

/**
 * Probador, preguntas sin respuesta y lote de regresión del asistente
 * (DISENO-CH-BOT §7, tanda 7b): las reglas que no dependen de la base.
 */

/** De dónde salió una respuesta, como la ve quien prueba. */
export type TipoDeFuente =
  | 'faq'
  | 'order'
  | 'catalog'
  | 'schedule'
  | 'payment_methods'
  | 'tool';

export interface FuenteDeLaPrueba {
  type: TipoDeFuente;
  /** El id de la pregunta frecuente o el número corto del pedido; nulo en el resto. */
  id: string | null;
  title: string;
}

/** Qué capa contestó: la fija (la IA no corrió: tope, sin clave, falla) o la inteligente. */
export type CapaDelAsistente = 'fixed' | 'ai';

/** Lo que contestaría el asistente a una pregunta, sin publicar nada. */
export interface VistaPrevia {
  answer: string | null;
  wouldHandOff: boolean;
  handOffReason: MotivoDeDerivacion | null;
  handOffReasonLabel: string | null;
  /** Con `requested`, la causa que dio el modelo; nula en el resto. */
  handOffCause: CausaDeDerivacion | null;
  handOffCauseLabel: string | null;
  sources: FuenteDeLaPrueba[];
  layer: CapaDelAsistente;
  assistantEnabled: boolean;
}

const HERRAMIENTAS: Readonly<
  Record<string, { type: TipoDeFuente; title: string }>
> = {
  [PRECIOS_VIGENTES]: { type: 'catalog', title: 'Precios vigentes' },
  [HORARIOS_Y_ZONAS]: { type: 'schedule', title: 'Horarios y zonas' },
  [MEDIOS_DE_PAGO]: { type: 'payment_methods', title: 'Medios de pago' },
};

/** La prueba del motor, como la ve el panel. */
export function vistaPrevia(prueba: ResultadoDeLaPrueba): VistaPrevia {
  const { resultado, fuentes, prendido } = prueba;
  const sources: FuenteDeLaPrueba[] = fuentes.map((f) => {
    if (f.type === 'faq') {
      return { type: 'faq', id: f.faqId, title: f.question };
    }
    if (f.tool === ESTADO_DE_MI_PEDIDO) {
      return f.orderNumber
        ? {
            type: 'order',
            id: f.orderNumber,
            title: `Pedido ${f.orderNumber}`,
          }
        : { type: 'order', id: null, title: 'Pedidos del cliente' };
    }
    const conocida = HERRAMIENTAS[f.tool];
    return conocida
      ? { ...conocida, id: null }
      : { type: 'tool', id: null, title: f.tool };
  });
  if (resultado.tipo === 'respuesta') {
    return {
      answer: resultado.texto,
      wouldHandOff: false,
      handOffReason: null,
      handOffReasonLabel: null,
      handOffCause: null,
      handOffCauseLabel: null,
      sources,
      layer: 'ai',
      assistantEnabled: prendido,
    };
  }
  const causa = causaDeLaTraza(resultado);
  return {
    answer: null,
    wouldHandOff: true,
    handOffReason: resultado.motivo,
    handOffReasonLabel: MOTIVOS_EN_CASTELLANO[resultado.motivo],
    handOffCause: causa,
    handOffCauseLabel: causa ? CAUSAS_EN_CASTELLANO[causa] : null,
    sources,
    layer: DERIVACIONES_SIN_IA.has(resultado.motivo) ? 'fixed' : 'ai',
    assistantEnabled: prendido,
  };
}

// ---------------------------------------------------------------------------
// Preguntas sin respuesta
// ---------------------------------------------------------------------------

/**
 * Motivos técnicos que cuentan como «no supo contestar»: el modelo corrió y
 * no llegó a una respuesta publicable (se negó, se pasó de vueltas o de
 * largo, no dio un texto que sirva o prometió algo que no hace, inventó un
 * importe). Quedan fuera las derivaciones en las que la IA no corrió (tope,
 * sin clave, falla de la API, rescate): no dicen nada de la base.
 */
export const MOTIVOS_SIN_RESPUESTA: readonly MotivoDeDerivacion[] =
  MOTIVOS_DE_DERIVACION.filter(
    (m) => !DERIVACIONES_SIN_IA.has(m) && m !== MotivoDeDerivacion.REQUESTED,
  );

/**
 * De `requested` (llamó a `pasar_a_persona`), sólo cuentan las causas de lo
 * que no sabía: no tenía la información o no estaba seguro. Que la persona
 * pida hablar con alguien o haga un reclamo no es «no supo».
 */
export const CAUSAS_SIN_RESPUESTA: readonly CausaDeDerivacion[] = [
  CausaDeDerivacion.NO_INFO,
  CausaDeDerivacion.LOW_CONFIDENCE,
];

/** Mensajes que se miran como mucho por consulta (los más nuevos del período). */
export const TOPE_DE_MENSAJES_SIN_RESPUESTA = 2000;

/** Grupos que se devuelven como mucho (los más repetidos). */
export const TOPE_DE_GRUPOS = 100;

/**
 * Palabras que no cambian lo que se pregunta (artículos, preposiciones,
 * pronombres): se sacan para agrupar «¿a qué hora abren?» con «hora que
 * abren». Sin tildes y sin letras repetidas, como las compara `comparable`.
 */
const VACIAS: ReadonlySet<string> = new Set([
  'el',
  'la',
  'los',
  'las',
  'lo',
  'un',
  'una',
  'unos',
  'unas',
  'a',
  'al',
  'del',
  'en',
  'y',
  'o',
  'u',
  'e',
  'por',
  'para',
  'con',
  'sin',
  'me',
  'mi',
  'mis',
  'te',
  'tu',
  'tus',
  'se',
  'su',
  'sus',
  'le',
  'les',
  'nos',
  'yo',
  'vos',
  'es',
  'esta',
  'este',
  'eso',
  'esto',
  'hay',
  'pero',
  'porfa',
  'favor',
  'quisiera',
  'queria',
  'quiero',
  'saber',
  'consulta',
  'consultar',
  'pregunta',
  'preguntar',
]);

function comparable(palabra: string): string {
  return palabra
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\p{L})\1+/gu, '$1');
}

/**
 * La forma normalizada de una pregunta para agrupar (sin embeddings): sin
 * saludos ni agradecimientos, sin tildes, mayúsculas, signos ni letras
 * repetidas, sin palabras vacías y con las palabras en orden alfabético (sin
 * repetir). Nula si no queda nada («hola», «gracias», un emoji).
 */
export function preguntaNormalizada(texto: string): string | null {
  const util = textoParaSugerir(texto);
  if (util === null) return null;
  const palabras = [
    ...new Set(
      util
        .split(' ')
        .map(comparable)
        .filter((p) => !VACIAS.has(p)),
    ),
  ].sort();
  return palabras.length > 0 ? palabras.join(' ') : null;
}

/** El id de un grupo: 32 hexadecimales de la forma normalizada. Estable entre consultas. */
export function idDelGrupo(normalizada: string): string {
  return createHash('sha256').update(normalizada).digest('hex').slice(0, 32);
}

export const ID_DE_GRUPO = /^[0-9a-f]{32}$/;

/** Un mensaje que el asistente no supo contestar. */
export interface MensajeSinRespuesta {
  body: string;
  createdAt: Date;
}

export interface GrupoSinRespuesta {
  id: string;
  /** El texto más reciente del grupo (como lo escribió la persona, sin espacios de más). */
  question: string;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Agrupa los mensajes por su forma normalizada. Un grupo resuelto o
 * descartado sólo cuenta lo que llegó después (`resueltos`: id → cuándo); si
 * no llegó nada, no aparece. Ordenados por cantidad y, a igual cantidad, por
 * el más reciente.
 */
export function agruparSinRespuesta(
  mensajes: readonly MensajeSinRespuesta[],
  resueltos: ReadonlyMap<string, Date>,
): GrupoSinRespuesta[] {
  const grupos = new Map<string, GrupoSinRespuesta>();
  for (const m of mensajes) {
    const normalizada = preguntaNormalizada(m.body);
    if (normalizada === null) continue;
    const id = idDelGrupo(normalizada);
    const resuelto = resueltos.get(id);
    if (resuelto && m.createdAt <= resuelto) continue;
    const texto = m.body.replace(/\s+/g, ' ').trim();
    const g = grupos.get(id);
    if (!g) {
      grupos.set(id, {
        id,
        question: texto,
        count: 1,
        firstSeenAt: m.createdAt,
        lastSeenAt: m.createdAt,
      });
      continue;
    }
    g.count += 1;
    if (m.createdAt > g.lastSeenAt) {
      g.lastSeenAt = m.createdAt;
      g.question = texto;
    }
    if (m.createdAt < g.firstSeenAt) g.firstSeenAt = m.createdAt;
  }
  return [...grupos.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.lastSeenAt.getTime() - a.lastSeenAt.getTime() ||
      (a.id < b.id ? -1 : 1),
  );
}

/** El id del grupo de una pregunta, o `null` si no queda nada al normalizarla. */
export function idDeLaPregunta(texto: string): string | null {
  const normalizada = preguntaNormalizada(texto);
  return normalizada === null ? null : idDelGrupo(normalizada);
}

/** Páginas que recorre como mucho la búsqueda de un grupo (2.000 mensajes cada una). */
export const VUELTAS_PARA_BUSCAR_UN_GRUPO = 25;

/** Los ids de grupo de unos mensajes (para buscar sólo sus resoluciones). */
export function idsDeLosGrupos(
  mensajes: readonly MensajeSinRespuesta[],
): string[] {
  const ids = new Set<string>();
  for (const m of mensajes) {
    const normalizada = preguntaNormalizada(m.body);
    if (normalizada !== null) ids.add(idDelGrupo(normalizada));
  }
  return [...ids];
}

/** La clave de la pregunta en borrador de la plataforma (su base la exige). */
export function claveDelBorrador(idDeGrupo: string): string {
  return `sin_respuesta_${idDeGrupo.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Lote de regresión
// ---------------------------------------------------------------------------

/** Casos vigentes por empresa. */
export const TOPE_DE_CASOS = 100;
/** Palabras o frases que tiene que mencionar una respuesta, por caso. */
export const TOPE_DE_MENCIONES = 10;
export const LARGO_DE_LA_MENCION = { min: 1, max: 100 } as const;
export const LARGO_DEL_CASO = { min: 2, max: 500 } as const;

/**
 * Latido de una corrida: cada caso terminado actualiza `updated_at`. Una
 * corrida «en curso» sin latido en este tiempo se da por perdida (el proceso
 * se reinició en el medio): `ultima()` la informa fallida y la siguiente la
 * marca así y arranca. Un caso tarda como mucho 4 consultas de 8 s.
 */
export const SEGUNDOS_SIN_LATIDO = 120;

/** Enfriamiento: una corrida por empresa cada tanto (cuesta tokens). */
export const MINUTOS_ENTRE_CORRIDAS = 10;

/** `true` si la corrida sigue «en curso» pero dejó de dar señales. */
export function corridaPerdida(
  corrida: { status: string; updatedAt: Date },
  ahora: Date,
): boolean {
  return (
    corrida.status === 'running' &&
    ahora.getTime() - corrida.updatedAt.getTime() > SEGUNDOS_SIN_LATIDO * 1000
  );
}

export type Esperado = 'answer' | 'handoff';
export type ResultadoDelCaso = 'passed' | 'failed' | 'error';
export type MotivoDelCaso =
  | 'expected_answer_got_handoff'
  | 'expected_handoff_got_answer'
  | 'missing_mentions'
  | 'assistant_not_run'
  | 'test_quota_reached'
  | 'case_error';

export interface Evaluacion {
  outcome: ResultadoDelCaso;
  reason: MotivoDelCaso | null;
  /** Por qué, en castellano, para el panel. */
  detail: string;
  /** Las menciones que faltaron (sólo con `missing_mentions`). */
  missing: string[];
}

/** Sin tildes ni mayúsculas, con los espacios simples: para buscar una mención. */
function paraBuscar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Si el caso pasó. Si la IA no corrió (capa fija: tope, sin clave, falla) no
 * se puede juzgar: `error`, no `failed`. Una respuesta esperada tiene que
 * mencionar todo lo pedido (sin distinguir mayúsculas ni tildes).
 */
export function evaluarCaso(
  caso: { expected: Esperado; mustMention: readonly string[] },
  vista: Pick<
    VistaPrevia,
    'answer' | 'wouldHandOff' | 'layer' | 'handOffReasonLabel'
  >,
): Evaluacion {
  if (vista.layer === 'fixed') {
    return {
      outcome: 'error',
      reason: 'assistant_not_run',
      detail: `No se pudo probar: ${vista.handOffReasonLabel ?? 'el asistente no respondió'}`,
      missing: [],
    };
  }
  if (caso.expected === 'handoff') {
    return vista.wouldHandOff
      ? {
          outcome: 'passed',
          reason: null,
          detail: 'Pasó a una persona, como se esperaba',
          missing: [],
        }
      : {
          outcome: 'failed',
          reason: 'expected_handoff_got_answer',
          detail: 'Se esperaba que pasara a una persona y respondió',
          missing: [],
        };
  }
  if (vista.wouldHandOff || vista.answer === null) {
    return {
      outcome: 'failed',
      reason: 'expected_answer_got_handoff',
      detail: `Se esperaba una respuesta y pasó a una persona (${vista.handOffReasonLabel ?? 'sin motivo'})`,
      missing: [],
    };
  }
  const respuesta = paraBuscar(vista.answer);
  const missing = caso.mustMention.filter(
    (m) => !respuesta.includes(paraBuscar(m)),
  );
  if (missing.length > 0) {
    return {
      outcome: 'failed',
      reason: 'missing_mentions',
      detail: `La respuesta no menciona: ${missing.join(', ')}`,
      missing,
    };
  }
  return {
    outcome: 'passed',
    reason: null,
    detail: 'Respondió y mencionó lo esperado',
    missing: [],
  };
}

/** Normaliza para comparar dos casos: sin mayúsculas ni espacios de los bordes (como el único de la base). */
export const casoNormalizado = (pregunta: string): string =>
  pregunta.trim().toLowerCase();

/** Lo que queda guardado de cada caso en la corrida: la foto del caso, lo que contestó y si pasó. */
export interface ResultadoDeCasoGuardado
  extends Evaluacion,
    Omit<VistaPrevia, 'assistantEnabled'> {
  caseId: string;
  question: string;
  expected: Esperado;
  mustMention: string[];
}
