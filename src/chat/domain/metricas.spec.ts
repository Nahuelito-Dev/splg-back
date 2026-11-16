import { BadRequestException } from '@nestjs/common';
import type { HorarioDeLaEmpresa } from './horario-de-la-empresa';
import {
  cumplimientoDeTickets,
  diasDelPeriodo,
  distribucionDePuntajes,
  etiquetaDelMotivo,
  mediana,
  medirEspera,
  metricasDelAsistente,
  minutosCorridos,
  motivosDeDerivacion,
  percentil,
  periodoDeLasMetricas,
  porClave,
  promedioDePuntajes,
  proporcion,
  resumirMedidas,
  resumirRespuestas,
  serieDiaria,
} from './metricas';

const ZONA = 'America/Argentina/Buenos_Aires';
/** Lunes a viernes de 8 a 12 (hora argentina). */
const HORARIO: HorarioDeLaEmpresa = {
  franjas: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    opensAt: '08:00',
    closesAt: '12:00',
  })),
  feriados: [],
  zona: ZONA,
};
/** Hora argentina (UTC−3) a instante. */
const ar = (diaYHora: string) => new Date(`${diaYHora}:00-03:00`);

describe('métricas del chat: cálculos', () => {
  describe('mediana y percentil', () => {
    it('mediana con cantidad impar y par (promedio de los del medio, un decimal)', () => {
      expect(mediana([7, 1, 3])).toBe(3);
      expect(mediana([1, 2, 3, 10])).toBe(2.5);
      expect(mediana([5])).toBe(5);
    });

    it('p90 por rango más cercano', () => {
      const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(percentil(v, 90)).toBe(9);
      expect(percentil([...v, 11], 90)).toBe(10);
      expect(percentil([4, 1], 90)).toBe(4);
      expect(percentil([3], 90)).toBe(3);
      expect(percentil(v, 0)).toBe(1);
    });

    it('sin valores: null, nunca NaN', () => {
      expect(mediana([])).toBeNull();
      expect(percentil([], 90)).toBeNull();
      expect(proporcion(0, 0)).toBeNull();
      expect(promedioDePuntajes([])).toBeNull();
    });

    it('proporción con tres decimales', () => {
      expect(proporcion(2, 3)).toBe(0.667);
      expect(proporcion(0, 5)).toBe(0);
      expect(proporcion(5, 5)).toBe(1);
    });

    it('minutos corridos redondeados y nunca negativos', () => {
      expect(
        minutosCorridos(ar('2026-11-16T08:00'), ar('2026-11-16T09:30')),
      ).toBe(90);
      expect(
        minutosCorridos(ar('2026-11-16T09:00'), ar('2026-11-16T08:00')),
      ).toBe(0);
    });
  });

  describe('período', () => {
    const ahora = ar('2026-11-16T10:00');

    it('sin fechas: los 30 días que terminan hoy (hora argentina)', () => {
      const p = periodoDeLasMetricas(undefined, undefined, ahora);
      expect(p.from).toBe('2026-10-18');
      expect(p.to).toBe('2026-11-16');
      expect(p.desde.toISOString()).toBe('2026-10-18T03:00:00.000Z');
      expect(p.hasta.toISOString()).toBe('2026-11-17T03:00:00.000Z');
      expect(diasDelPeriodo(p)).toHaveLength(30);
    });

    it('sólo `to`: los 30 días que terminan ahí; sólo `from`: hasta hoy', () => {
      expect(periodoDeLasMetricas(undefined, '2026-03-31', ahora).from).toBe(
        '2026-03-02',
      );
      expect(periodoDeLasMetricas('2026-11-01', undefined, ahora)).toEqual(
        expect.objectContaining({ from: '2026-11-01', to: '2026-11-16' }),
      );
    });

    it('hasta 366 días; más, «desde» posterior o una fecha que no existe: 400', () => {
      expect(periodoDeLasMetricas('2025-11-16', '2026-11-16', ahora).from).toBe(
        '2025-11-16',
      );
      expect(() =>
        periodoDeLasMetricas('2025-11-15', '2026-11-16', ahora),
      ).toThrow(BadRequestException);
      expect(() =>
        periodoDeLasMetricas('2026-11-10', '2026-11-01', ahora),
      ).toThrow(BadRequestException);
      expect(() =>
        periodoDeLasMetricas(undefined, '2026-02-30', ahora),
      ).toThrow(BadRequestException);
      expect(() =>
        periodoDeLasMetricas('2026-13-01', undefined, ahora),
      ).toThrow(BadRequestException);
    });
  });

  describe('primera respuesta en minutos hábiles', () => {
    const ahora = ar('2026-11-17T12:00');

    it('no cuenta la noche ni el fin de semana: viernes 11:50 → lunes 8:20 son 30 minutos', () => {
      const r = resumirRespuestas(
        [
          {
            desde: ar('2026-11-13T11:50'),
            hasta: ar('2026-11-16T08:20'),
            cerrada: false,
          },
        ],
        HORARIO,
        30,
        ahora,
      );
      expect(r).toEqual({
        responded: 1,
        unanswered: 0,
        closedWithoutHumanReply: 0,
        medianMinutes: 30,
        p90Minutes: 30,
        target: { met: 1, missed: 0, rate: 1 },
      });
    });

    it('un feriado no suma: con el lunes sin atención, viernes 11:50 → martes 8:20 también son 30', () => {
      const conFeriado = {
        ...HORARIO,
        feriados: [{ date: '2026-11-16', reason: 'Feriado' }],
      };
      const esperas = [
        {
          desde: ar('2026-11-13T11:50'),
          hasta: ar('2026-11-17T08:20'),
          cerrada: false,
        },
      ];
      expect(
        resumirRespuestas(esperas, conFeriado, 30, ahora).medianMinutes,
      ).toBe(30);
      // Sin el feriado, el lunes entero (4 h) suma.
      expect(resumirRespuestas(esperas, HORARIO, 30, ahora).medianMinutes).toBe(
        270,
      );
    });

    it('objetivo: a tiempo, fuera de término y las que esperan y ya lo pasaron', () => {
      const r = resumirRespuestas(
        [
          {
            desde: ar('2026-11-16T08:00'),
            hasta: ar('2026-11-16T08:10'),
            cerrada: false,
          },
          {
            desde: ar('2026-11-16T08:00'),
            hasta: ar('2026-11-16T08:30'),
            cerrada: false,
          },
          {
            desde: ar('2026-11-16T08:00'),
            hasta: ar('2026-11-16T09:00'),
            cerrada: false,
          },
          // Espera desde el martes 11:00: 60 hábiles a las 12:00 → fuera.
          { desde: ar('2026-11-17T11:00'), hasta: null, cerrada: false },
          // Espera desde las 11:45: 15 hábiles, todavía en plazo → no cuenta.
          { desde: ar('2026-11-17T11:45'), hasta: null, cerrada: false },
        ],
        HORARIO,
        30,
        ahora,
      );
      expect(r).toEqual({
        responded: 3,
        unanswered: 2,
        closedWithoutHumanReply: 0,
        medianMinutes: 30,
        p90Minutes: 60,
        target: { met: 2, missed: 2, rate: 0.5 },
      });
    });

    it('sin objetivo, `target` nulo; sin esperas, ceros y null', () => {
      expect(
        resumirRespuestas(
          [
            {
              desde: ar('2026-11-16T08:00'),
              hasta: ar('2026-11-16T08:05'),
              cerrada: false,
            },
          ],
          HORARIO,
          null,
          ahora,
        ).target,
      ).toBeNull();
      expect(resumirRespuestas([], HORARIO, 30, ahora)).toEqual({
        responded: 0,
        unanswered: 0,
        closedWithoutHumanReply: 0,
        medianMinutes: null,
        p90Minutes: null,
        target: { met: 0, missed: 0, rate: null },
      });
    });

    it('sin franjas cargadas atiende todo el día: cuenta reloj corrido', () => {
      const siempre = { franjas: [], feriados: [], zona: ZONA };
      expect(
        resumirRespuestas(
          [
            {
              desde: ar('2026-11-14T22:00'),
              hasta: ar('2026-11-15T01:00'),
              cerrada: false,
            },
          ],
          siempre,
          null,
          ahora,
        ).medianMinutes,
      ).toBe(180);
    });
  });

  describe('cerradas sin respuesta y respuestas anteriores al inicio', () => {
    const ahora = ar('2026-11-17T12:00');

    it('una cerrada sin respuesta de una persona no entra en el TPR ni en el objetivo: va aparte', () => {
      const r = resumirRespuestas(
        [
          {
            desde: ar('2026-11-16T08:00'),
            hasta: ar('2026-11-16T08:10'),
            cerrada: true,
          },
          // La resolvió el asistente y se cerró: sin `first_response_at`.
          { desde: ar('2026-11-13T08:00'), hasta: null, cerrada: true },
          // Abierta y vencida: sí cuenta fuera.
          { desde: ar('2026-11-17T09:00'), hasta: null, cerrada: false },
        ],
        HORARIO,
        30,
        ahora,
      );
      expect(r).toEqual({
        responded: 1,
        unanswered: 1,
        closedWithoutHumanReply: 1,
        medianMinutes: 10,
        p90Minutes: 10,
        target: { met: 1, missed: 1, rate: 0.5 },
      });
    });

    it('una respuesta anterior al inicio no se mide ni cuenta', () => {
      expect(
        medirEspera(
          {
            desde: ar('2026-11-16T09:00'),
            hasta: ar('2026-11-16T08:59'),
            cerrada: false,
          },
          HORARIO,
          30,
          ahora,
        ),
      ).toEqual({ estado: 'excluida' });
      expect(resumirMedidas([{ estado: 'excluida' }], 30)).toEqual({
        responded: 0,
        unanswered: 0,
        closedWithoutHumanReply: 0,
        medianMinutes: null,
        p90Minutes: null,
        target: { met: 0, missed: 0, rate: null },
      });
    });

    it('esperando sin objetivo: `vencida` nula y no cuenta en ningún lado salvo `unanswered`', () => {
      expect(
        medirEspera(
          { desde: ar('2026-11-13T09:00'), hasta: null, cerrada: false },
          HORARIO,
          null,
          ahora,
        ),
      ).toEqual({ estado: 'esperando', vencida: null });
    });
  });

  describe('tickets contra su vencimiento', () => {
    it('a tiempo hasta el vencimiento inclusive; vencido sin responder cuenta fuera; en plazo o sin vencimiento no cuenta', () => {
      const vence = ar('2026-11-16T10:00');
      const t = (
        respondido: Date | null,
        v: Date | null = vence,
        terminado = false,
      ) => ({
        creado: ar('2026-11-16T08:00'),
        respondido,
        vence: v,
        terminado,
      });
      expect(
        cumplimientoDeTickets(
          [
            t(ar('2026-11-16T09:00')),
            t(vence),
            t(ar('2026-11-16T10:01')),
            t(null),
            t(null, ar('2026-11-16T13:00')),
            t(ar('2026-11-16T09:00'), null),
          ],
          ar('2026-11-16T12:00'),
        ),
      ).toEqual({ met: 2, missed: 2, rate: 0.5 });
      expect(cumplimientoDeTickets([], new Date())).toEqual({
        met: 0,
        missed: 0,
        rate: null,
      });
    });

    it('terminado sin respuesta o con la respuesta anterior a la apertura: no cuenta', () => {
      const vence = ar('2026-11-16T10:00');
      expect(
        cumplimientoDeTickets(
          [
            // Resuelto sin escribir, ya vencido: no es fuera de término.
            {
              creado: ar('2026-11-16T08:00'),
              respondido: null,
              vence,
              terminado: true,
            },
            // Abierto desde un chat ya respondido (respuesta copiada del chat).
            {
              creado: ar('2026-11-16T08:00'),
              respondido: ar('2026-11-16T07:59'),
              vence,
              terminado: false,
            },
          ],
          ar('2026-11-16T12:00'),
        ),
      ).toEqual({ met: 0, missed: 0, rate: null });
    });
  });

  describe('asistente, claves, puntajes y serie', () => {
    it('motivos en castellano, el más frecuente primero; uno desconocido es «Otro motivo»', () => {
      expect(
        motivosDeDerivacion([
          { reason: 'timeout', count: 1 },
          { reason: 'requested', count: 2 },
          { reason: 'requested', count: 1 },
          { reason: 'api_error', count: 1 },
        ]),
      ).toEqual([
        {
          reason: 'requested',
          label:
            'El asistente no pudo resolverlo o la persona pidió hablar con alguien',
          count: 3,
        },
        {
          reason: 'api_error',
          label: 'Falla del servicio del asistente',
          count: 1,
        },
        {
          reason: 'timeout',
          label: 'El asistente tardó demasiado en responder',
          count: 1,
        },
      ]);
      expect(etiquetaDelMotivo('raro')).toBe('Otro motivo');
      expect(motivosDeDerivacion([{ reason: null, count: 1 }])[0]).toEqual({
        reason: 'unknown',
        label: 'Otro motivo',
        count: 1,
      });
    });

    it('métricas del asistente: respuestas, derivaciones y resueltas sin persona', () => {
      expect(
        metricasDelAsistente(
          [
            { outcome: 'answered', reason: null, count: 5, conversations: 3 },
            {
              outcome: 'handed_off',
              reason: 'requested',
              count: 2,
              conversations: 2,
            },
          ],
          4,
          { closedWithAssistant: 3, resolvedWithoutHuman: 2 },
        ),
      ).toEqual({
        aiReplies: 5,
        handoffs: 2,
        handoffReasons: [
          {
            reason: 'requested',
            label: expect.any(String) as string,
            count: 2,
          },
        ],
        conversationsAttended: 4,
        closedWithAssistant: 3,
        resolvedWithoutHuman: 2,
        resolvedWithoutHumanRate: 0.667,
      });
      expect(
        metricasDelAsistente([], 0, {
          closedWithAssistant: 0,
          resolvedWithoutHuman: 0,
        }),
      ).toEqual({
        aiReplies: 0,
        handoffs: 0,
        handoffReasons: [],
        conversationsAttended: 0,
        closedWithAssistant: 0,
        resolvedWithoutHuman: 0,
        resolvedWithoutHumanRate: null,
      });
    });

    it('por clave: suma repetidas, la más usada primero y el total', () => {
      expect(
        porClave([
          { key: 'saludo', count: 2 },
          { key: 'pagos', count: 3 },
          { key: 'saludo', count: 2 },
        ]),
      ).toEqual({
        total: 7,
        byKey: [
          { key: 'saludo', count: 4 },
          { key: 'pagos', count: 3 },
        ],
      });
      expect(porClave([])).toEqual({ total: 0, byKey: [] });
    });

    it('puntajes: siempre los cinco y el promedio ponderado', () => {
      const p = [
        { score: 5, count: 3 },
        { score: 2, count: 1 },
      ];
      expect(distribucionDePuntajes(p)).toEqual([
        { score: 1, count: 0 },
        { score: 2, count: 1 },
        { score: 3, count: 0 },
        { score: 4, count: 0 },
        { score: 5, count: 3 },
      ]);
      expect(promedioDePuntajes(p)).toBe(4.25);
    });

    it('serie diaria por día argentino, con los días vacíos en cero y null', () => {
      const serie = serieDiaria(
        ['2026-11-15', '2026-11-16', '2026-11-17'],
        [
          // 23:30 del 15 en Argentina (02:30Z del 16): cuenta el 15.
          { creada: ar('2026-11-15T23:30'), minutos: 10 },
          { creada: ar('2026-11-17T09:00'), minutos: 4 },
          { creada: ar('2026-11-17T10:00'), minutos: null },
          { creada: ar('2026-11-17T11:00'), minutos: 8 },
          // Fuera del período: no suma.
          { creada: ar('2026-11-20T11:00'), minutos: 1 },
        ],
      );
      expect(serie).toEqual([
        {
          date: '2026-11-15',
          newConversations: 1,
          firstResponseMedianMinutes: 10,
        },
        {
          date: '2026-11-16',
          newConversations: 0,
          firstResponseMedianMinutes: null,
        },
        {
          date: '2026-11-17',
          newConversations: 3,
          firstResponseMedianMinutes: 6,
        },
      ]);
    });
  });
});
