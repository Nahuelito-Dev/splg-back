import { Injectable } from '@nestjs/common';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  Party,
} from '../domain/chat.enums';
import {
  type ClaveContada,
  diasDelPeriodo,
  type DiaDeLaSerie,
  type Espera,
  type MedidaDeEspera,
  mediana,
  medirEspera,
  metricasDelAsistente,
  type MetricasDelAsistente,
  minutosCorridos,
  periodoDeLasMetricas,
  porClave,
  proporcion,
  type ResumenDeRespuesta,
  resumirMedidas,
  serieDiaria,
} from '../domain/metricas';
import {
  type ConversacionDelPeriodo,
  type EtiquetaDelPeriodo,
  MetricasReadModel,
  type Rango,
} from '../infrastructure/metricas-read-model';
import {
  type GrupoDeLaEncuesta,
  resumirEncuestas,
} from './bandeja-encuesta.service';
import {
  CompanyChatSettingsService,
  horarioDe,
} from './company-chat-settings.service';

export type CanalDeLasMetricas = Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;

export interface ResolucionDelChat {
  /** Cerradas (sin contar las que se cerraron porque el pedido pasó a otro chofer). */
  closed: number;
  /** Mediana de cierre − creación, en minutos de reloj corrido. */
  medianMinutes: number | null;
}

export interface MetricasDeUnCanal {
  channel: CanalDeLasMetricas;
  conversations: number;
  firstResponse: ResumenDeRespuesta;
  resolution: ResolucionDelChat;
  live: EnVivo;
}

export interface EnVivo {
  open: number;
  unassigned: number;
  unanswered: number;
  awaitingHuman: number;
}

export interface SatisfaccionDelChat {
  requested: number;
  answered: number;
  expired: number;
  responseRate: number | null;
  average: number | null;
  csat: number | null;
  byScore: Array<{ score: number; count: number }>;
  assistant: GrupoDeLaEncuesta;
  team: GrupoDeLaEncuesta;
}

/** Una etiqueta en las métricas (7c): sus conversaciones del período y su TPR. */
export interface MetricasDeUnaEtiqueta {
  label: { id: string; name: string; color: string };
  conversations: number;
  firstResponse: ResumenDeRespuesta;
}

export interface MetricasDelChat {
  from: string;
  to: string;
  channel: CanalDeLasMetricas | null;
  targetMinutes: number;
  conversations: number;
  firstResponse: ResumenDeRespuesta;
  resolution: ResolucionDelChat;
  live: EnVivo;
  byChannel: MetricasDeUnCanal[];
  byLabel: MetricasDeUnaEtiqueta[];
  assistant: (MetricasDelAsistente & { enabled: boolean }) | null;
  automaticReplies: { total: number; byKey: ClaveContada[] };
  quickReplies: { total: number; byKey: ClaveContada[] };
  satisfaction: SatisfaccionDelChat | null;
  daily: DiaDeLaSerie[];
}

/** Lo que pide el panel de la empresa. */
export interface ConsultaDeMetricas {
  from?: string;
  to?: string;
  channel?: CanalDeLasMetricas;
}

/**
 * La espera de una conversación: desde el primer mensaje del cliente o del
 * chofer hasta la primera respuesta del equipo (`first_response_at`). Sin
 * mensaje de la persona (la abrió la empresa y nadie contestó), no hay espera.
 */
const espera = (c: ConversacionDelPeriodo): Espera | null =>
  c.firstIncomingAt
    ? {
        desde: c.firstIncomingAt,
        hasta: c.firstResponseAt,
        cerrada: c.status === ConversationStatus.CLOSED,
      }
    : null;

/** Cada conversación con su espera medida UNA vez (los minutos hábiles son lo caro). */
interface ConversacionMedida {
  c: ConversacionDelPeriodo;
  medida: MedidaDeEspera | null;
}

const medidasDe = (cs: readonly ConversacionMedida[]): MedidaDeEspera[] =>
  cs.flatMap((x) => (x.medida ? [x.medida] : []));

/** Cerradas por un motivo técnico (el pedido pasó a otro chofer): no son una resolución. */
const esResolucion = (
  c: ConversacionDelPeriodo,
): c is ConversacionDelPeriodo & {
  closedAt: Date;
} =>
  c.closedAt !== null &&
  c.closedReason !== ConversationClosedReason.DRIVER_CHANGED;

function resolucion(conversaciones: readonly ConversacionDelPeriodo[]) {
  const minutos = conversaciones
    .filter(esResolucion)
    .map((c) => minutosCorridos(c.createdAt, c.closedAt));
  return { closed: minutos.length, medianMinutes: mediana(minutos) };
}

/**
 * El corte por etiqueta: cada etiqueta vigente (también sin conversaciones)
 * con las del período que la tienen y su TPR, con las medidas ya hechas.
 */
export function porEtiqueta(
  filas: readonly EtiquetaDelPeriodo[],
  conversaciones: readonly ConversacionMedida[],
  objetivo: number,
): MetricasDeUnaEtiqueta[] {
  const porId = new Map(conversaciones.map((x) => [x.c.conversationId, x]));
  const etiquetas = new Map<
    string,
    { label: MetricasDeUnaEtiqueta['label']; de: ConversacionMedida[] }
  >();
  for (const f of filas) {
    const e = etiquetas.get(f.labelId) ?? {
      label: { id: f.labelId, name: f.name, color: f.color },
      de: [],
    };
    const x = f.conversationId ? porId.get(f.conversationId) : undefined;
    if (x) e.de.push(x);
    etiquetas.set(f.labelId, e);
  }
  return [...etiquetas.values()].map(({ label, de }) => ({
    label,
    conversations: de.length,
    firstResponse: resumirMedidas(medidasDe(de), objetivo),
  }));
}

const VIVO_VACIO: EnVivo = {
  open: 0,
  unassigned: 0,
  unanswered: 0,
  awaitingHuman: 0,
};

/**
 * Métricas de la bandeja de una empresa (DISENO-COMUNICACION §15.2 «Mensajes →
 * Métricas» y §16; DISENO-CH-BOT §8): tiempo de primera respuesta en minutos
 * hábiles de su horario y contra su objetivo, resolución, lo abierto en vivo,
 * el asistente (si la empresa lo tiene), respuestas automáticas y rápidas,
 * encuesta y una serie diaria. Siempre de UNA empresa: todas las consultas
 * llevan su `distributor_id`.
 */
@Injectable()
export class ChatMetricsService {
  constructor(
    private readonly lectura: MetricasReadModel,
    private readonly ajustes: CompanyChatSettingsService,
  ) {}

  async deLaEmpresa(
    distributorId: string,
    consulta: ConsultaDeMetricas,
    ahora: Date = new Date(),
  ): Promise<MetricasDelChat> {
    const periodo = periodoDeLasMetricas(consulta.from, consulta.to, ahora);
    const rango: Rango = { desde: periodo.desde, hasta: periodo.hasta };
    const canales: CanalDeLasMetricas[] = consulta.channel
      ? [consulta.channel]
      : [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER];
    const conClientes = canales.includes(Channel.STAFF_CUSTOMER);

    // De a cuatro consultas como mucho: no ocupar el pool con un tablero.
    const [ajustes, filas, vivo, plantillas] = await Promise.all([
      this.ajustes.leer(distributorId),
      this.lectura.conversacionesDelPeriodo(distributorId, canales, rango),
      this.lectura.enVivo(distributorId, canales),
      this.lectura.usoDePlantillas(distributorId, canales, rango),
    ]);
    const asistenteDisponible =
      conClientes &&
      (await this.ajustes.asistenteConIaDisponible(distributorId));
    const horario = horarioDe(ajustes);
    const objetivo = ajustes.firstResponseTargetMinutes;
    const conversaciones: ConversacionMedida[] = filas.map((c) => {
      const e = espera(c);
      return {
        c,
        medida: e ? medirEspera(e, horario, objetivo, ahora) : null,
      };
    });

    const byChannel = canales.map((channel): MetricasDeUnCanal => {
      const delCanal = conversaciones.filter((x) => x.c.channel === channel);
      const v = vivo.find((f) => f.channel === channel);
      return {
        channel,
        conversations: delCanal.length,
        firstResponse: resumirMedidas(medidasDe(delCanal), objetivo),
        resolution: resolucion(delCanal.map((x) => x.c)),
        live: v
          ? {
              open: v.open,
              unassigned: v.unassigned,
              unanswered: v.unanswered,
              awaitingHuman: v.awaitingHuman,
            }
          : { ...VIVO_VACIO },
      };
    });

    const [asistente, satisfaccion, etiquetas] = await Promise.all([
      asistenteDisponible
        ? this.asistente(distributorId, rango).then((a) => ({
            enabled: ajustes.assistantAiEnabled,
            ...a,
          }))
        : Promise.resolve(null),
      conClientes
        ? this.satisfaccion(distributorId, rango, ahora)
        : Promise.resolve(null),
      this.lectura.etiquetasDelPeriodo(distributorId, canales, rango),
    ]);

    return {
      from: periodo.from,
      to: periodo.to,
      channel: consulta.channel ?? null,
      targetMinutes: objetivo,
      conversations: conversaciones.length,
      firstResponse: resumirMedidas(medidasDe(conversaciones), objetivo),
      resolution: resolucion(filas),
      live: byChannel.reduce(
        (t, c) => ({
          open: t.open + c.live.open,
          unassigned: t.unassigned + c.live.unassigned,
          unanswered: t.unanswered + c.live.unanswered,
          awaitingHuman: t.awaitingHuman + c.live.awaitingHuman,
        }),
        { ...VIVO_VACIO },
      ),
      byChannel,
      byLabel: porEtiqueta(etiquetas, conversaciones, objetivo),
      assistant: asistente,
      automaticReplies: porClave(plantillas.filter((p) => p.kind === 'auto')),
      quickReplies: porClave(plantillas.filter((p) => p.kind === 'quick')),
      satisfaction: satisfaccion,
      daily: serieDiaria(
        diasDelPeriodo(periodo),
        conversaciones.map((x) => ({
          creada: x.c.createdAt,
          minutos: x.medida?.estado === 'respondida' ? x.medida.minutos : null,
        })),
      ),
    };
  }

  private async asistente(
    distributorId: string,
    rango: Rango,
  ): Promise<MetricasDelAsistente> {
    const [{ trazas, atendidas }, resueltas] = await Promise.all([
      this.lectura.trazasDelAsistente(
        Channel.STAFF_CUSTOMER,
        rango,
        distributorId,
      ),
      this.lectura.resueltasSinPersona(
        Channel.STAFF_CUSTOMER,
        Party.COMPANY,
        rango,
        distributorId,
      ),
    ]);
    const propias = resueltas.find((r) => r.distributorId === distributorId);
    return metricasDelAsistente(
      trazas.filter((t) => t.distributorId === distributorId),
      atendidas.get(distributorId) ?? 0,
      {
        closedWithAssistant: propias?.closedWithAssistant ?? 0,
        resolvedWithoutHuman: propias?.resolvedWithoutHuman ?? 0,
      },
    );
  }

  private async satisfaccion(
    distributorId: string,
    rango: Rango,
    ahora: Date,
  ): Promise<SatisfaccionDelChat> {
    const filas = await this.lectura.encuestas(distributorId, rango, ahora);
    const r = resumirEncuestas(filas, rango.desde, rango.hasta);
    return {
      requested: r.requested,
      answered: r.answered,
      expired: r.expired,
      responseRate: proporcion(r.answered, r.requested),
      average: r.average,
      csat: r.csat,
      byScore: [1, 2, 3, 4, 5].map((score) => ({
        score,
        count: r.byScore[String(score)] ?? 0,
      })),
      assistant: r.assistant,
      team: r.team,
    };
  }
}
