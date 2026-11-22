import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Channel,
  ConversationStatus,
  Party,
  TicketStatus,
} from '../domain/chat.enums';
import type { HorarioDeLaEmpresa } from '../domain/horario-de-la-empresa';
import { minutosHabiles } from '../domain/horario-de-la-empresa';
import {
  type Cumplimiento,
  cumplimientoDeTickets,
  distribucionDePuntajes,
  mediana,
  metricasDelAsistente,
  type MetricasDelAsistente,
  minutosCorridos,
  periodoDeLasMetricas,
  promedioDePuntajes,
  proporcion,
  type ResumenDeRespuesta,
  resumirRespuestas,
} from '../domain/metricas';
import {
  MetricasReadModel,
  type Rango,
  type ResueltasDeEmpresa,
  type TrazaDeEmpresa,
} from '../infrastructure/metricas-read-model';
import { SupportSettingsService } from './support-settings.service';
import { EntityPhotoService } from '../../s3/entity-photo.service';

export interface MetricasDelChatDeSoporte {
  /** Chats con la plataforma creados en el período. */
  chats: number;
  /** Abiertos, con un mensaje de la empresa sin respuesta (en vivo). */
  waiting: number;
  /** La espera más larga de ésos, en minutos hábiles del soporte. */
  longestWaitMinutes: number | null;
  medianWaitMinutes: number | null;
  firstResponse: ResumenDeRespuesta;
  endedInTicket: number;
  endedInTicketRate: number | null;
}

export interface MetricasDeTickets {
  created: number;
  open: number;
  overdue: number;
  firstResponse: ResumenDeRespuesta & { target: Cumplimiento };
  resolution: { resolved: number; medianMinutes: number | null };
  satisfaction: {
    rated: number;
    responseRate: number | null;
    average: number | null;
    byScore: Array<{ score: number; count: number }>;
  };
}

export interface MetricasDeUnaEmpresa {
  distributorId: string;
  name: string;
  /** Logo de la empresa: URL firmada de corta vigencia, o `null` si no tiene. */
  logoUrl: string | null;
  conversations: number;
  messages: number;
  /** Sólo si la empresa usó el asistente en el período. */
  assistant: MetricasDelAsistente | null;
}

export interface MetricasDeLaPlataforma {
  from: string;
  to: string;
  distributorId: string | null;
  chat: MetricasDelChatDeSoporte;
  tickets: MetricasDeTickets;
  assistant: MetricasDelAsistente;
  companies: MetricasDeUnaEmpresa[];
}

export interface ConsultaDeMetricasDePlataforma {
  from?: string;
  to?: string;
  distributorId?: string;
}

const TERMINADOS: ReadonlySet<string> = new Set([
  TicketStatus.RESOLVED,
  TicketStatus.CLOSED,
]);

/**
 * Métricas de la plataforma (DISENO-COMUNICACION §15.1 «Tablero» y «Uso →
 * Chat», §16; DISENO-CH-BOT §8): el soporte C1 (chat y tickets por separado,
 * en minutos hábiles del horario del soporte), su asistente y, por empresa,
 * sólo conteos de la bandeja y lo que hizo su asistente. Nunca texto de un
 * mensaje.
 */
@Injectable()
export class PlatformChatMetricsService {
  constructor(
    private readonly lectura: MetricasReadModel,
    private readonly soporte: SupportSettingsService,
    private readonly fotos: EntityPhotoService,
  ) {}

  async metricas(
    consulta: ConsultaDeMetricasDePlataforma,
    ahora: Date = new Date(),
  ): Promise<MetricasDeLaPlataforma> {
    const periodo = periodoDeLasMetricas(consulta.from, consulta.to, ahora);
    const empresa = consulta.distributorId ?? null;
    if (empresa && !(await this.lectura.existeLaEmpresa(empresa))) {
      throw new NotFoundException('No existe la empresa');
    }
    const rango: Rango = { desde: periodo.desde, hasta: periodo.hasta };
    // En tandas de cuatro: sin `distributorId` son consultas sobre todas las
    // empresas y no deben ocupar el pool entero a la vez.
    const [ajustes, chats, esperando, ticketsVivos] = await Promise.all([
      this.soporte.leer(),
      this.lectura.chatsDeSoporte(rango, empresa),
      this.lectura.chatsEsperando(empresa),
      this.lectura.ticketsEnVivo(ahora, empresa),
    ]);
    const [tickets, soporte, resueltasSoporte, uso] = await Promise.all([
      this.lectura.ticketsDelPeriodo(rango, empresa),
      this.lectura.trazasDelAsistente(Channel.PLATFORM_CHAT, rango, empresa),
      this.lectura.resueltasSinPersona(
        Channel.PLATFORM_CHAT,
        Party.PLATFORM,
        rango,
        empresa,
      ),
      this.lectura.usoPorEmpresa(rango, empresa),
    ]);
    const [deEmpresas, resueltasEmpresas] = await Promise.all([
      this.lectura.trazasDelAsistente(Channel.STAFF_CUSTOMER, rango, empresa),
      this.lectura.resueltasSinPersona(
        Channel.STAFF_CUSTOMER,
        Party.COMPANY,
        rango,
        empresa,
      ),
    ]);
    // La key del logo vino en la consulta del uso: sólo falta firmarla.
    const logos = await Promise.all(
      uso.map((u) => this.fotos.urlDe(u.logoKey)),
    );
    const horario: HorarioDeLaEmpresa = {
      franjas: ajustes.chatHours,
      feriados: [],
      zona: ajustes.timezone,
    };

    const esperas = chats.flatMap((c) =>
      c.firstCompanyAt
        ? [
            {
              desde: c.firstCompanyAt,
              hasta: c.firstReplyAt,
              cerrada: c.status === ConversationStatus.CLOSED,
            },
          ]
        : [],
    );
    const minutosEsperando = esperando.map((desde) =>
      minutosHabiles(horario, desde, ahora),
    );
    const conTicket = chats.filter((c) => c.hasTicket).length;

    const deLaEmpresa = tickets.filter(
      (t) => t.openedByParty === Party.COMPANY,
    );
    const respuestasDeTickets = resumirRespuestas(
      deLaEmpresa.map((t) => ({
        desde: t.createdAt,
        hasta: t.firstResponseAt,
        cerrada: TERMINADOS.has(t.status),
      })),
      horario,
      null,
      ahora,
    );
    const resueltos = tickets.flatMap((t) =>
      t.resolvedAt ? [minutosCorridos(t.createdAt, t.resolvedAt)] : [],
    );
    const puntajes = tickets.flatMap((t) =>
      t.satisfaction !== null ? [{ score: t.satisfaction, count: 1 }] : [],
    );
    // Sólo se califica al confirmar, y confirmar lo cierra: el denominador son los cerrados.
    const cerrados = tickets.filter(
      (t) => t.status === TicketStatus.CLOSED,
    ).length;

    return {
      from: periodo.from,
      to: periodo.to,
      distributorId: empresa,
      chat: {
        chats: chats.length,
        waiting: esperando.length,
        longestWaitMinutes:
          minutosEsperando.length > 0 ? Math.max(...minutosEsperando) : null,
        medianWaitMinutes: mediana(minutosEsperando),
        firstResponse: resumirRespuestas(esperas, horario, null, ahora),
        endedInTicket: conTicket,
        endedInTicketRate: proporcion(conTicket, chats.length),
      },
      tickets: {
        created: tickets.length,
        open: ticketsVivos.open,
        overdue: ticketsVivos.overdue,
        firstResponse: {
          ...respuestasDeTickets,
          target: cumplimientoDeTickets(
            deLaEmpresa.map((t) => ({
              creado: t.createdAt,
              respondido: t.firstResponseAt,
              vence: t.firstResponseDueAt,
              terminado: TERMINADOS.has(t.status),
            })),
            ahora,
          ),
        },
        resolution: {
          resolved: resueltos.length,
          medianMinutes: mediana(resueltos),
        },
        satisfaction: {
          rated: puntajes.length,
          responseRate: proporcion(puntajes.length, cerrados),
          average: promedioDePuntajes(puntajes),
          byScore: distribucionDePuntajes(puntajes),
        },
      },
      assistant: asistenteDe(
        soporte.trazas,
        soporte.atendidas,
        resueltasSoporte,
      ),
      companies: uso.map((u, i) => {
        const propias = deEmpresas.trazas.filter(
          (t) => t.distributorId === u.distributorId,
        );
        return {
          distributorId: u.distributorId,
          name: u.name,
          logoUrl: logos[i],
          conversations: u.conversations,
          messages: u.messages,
          assistant:
            propias.length > 0
              ? asistenteDe(
                  propias,
                  deEmpresas.atendidas,
                  resueltasEmpresas.filter(
                    (r) => r.distributorId === u.distributorId,
                  ),
                  u.distributorId,
                )
              : null,
        };
      }),
    };
  }
}

/** El asistente de todas las filas (o sólo de una empresa). */
function asistenteDe(
  trazas: readonly TrazaDeEmpresa[],
  atendidas: ReadonlyMap<string, number>,
  resueltas: readonly ResueltasDeEmpresa[],
  distributorId?: string,
): MetricasDelAsistente {
  const atendidasDe = distributorId
    ? (atendidas.get(distributorId) ?? 0)
    : [...atendidas.values()].reduce((s, n) => s + n, 0);
  return metricasDelAsistente(trazas, atendidasDe, {
    closedWithAssistant: resueltas.reduce(
      (s, r) => s + r.closedWithAssistant,
      0,
    ),
    resolvedWithoutHuman: resueltas.reduce(
      (s, r) => s + r.resolvedWithoutHuman,
      0,
    ),
  });
}
