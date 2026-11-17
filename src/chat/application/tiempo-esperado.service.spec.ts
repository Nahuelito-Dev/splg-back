import type { RedisService } from '../../redis/redis.service';
import { Channel, ConversationStatus } from '../domain/chat.enums';
import type { ChatCompanySettings } from '../entities/chat-company-settings.entity';
import type {
  ConversacionDelPeriodo,
  MetricasReadModel,
} from '../infrastructure/metricas-read-model';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';
import {
  claveDelTiempoEsperado,
  TiempoEsperadoService,
  TTL_DEL_TIEMPO_ESPERADO_SEG,
} from './tiempo-esperado.service';

const A = 'empresa-a';
// Lunes 16/11/2026 a las 12 (Argentina): la empresa atiende todo el día.
const AHORA = new Date('2026-11-16T15:00:00Z');

const respondida = (minutos: number, i: number): ConversacionDelPeriodo => {
  const desde = new Date(AHORA.getTime() - (i + 1) * 3_600_000);
  return {
    conversationId: `c-${i}`,
    channel: Channel.STAFF_CUSTOMER,
    status: ConversationStatus.CLOSED,
    createdAt: desde,
    firstIncomingAt: desde,
    firstResponseAt: new Date(desde.getTime() + minutos * 60_000),
    closedAt: null,
    closedReason: null,
  };
};

function armar(
  opciones: {
    ajustes?: Partial<ChatCompanySettings>;
    filas?: ConversacionDelPeriodo[];
    cache?: string | null;
    redisRoto?: boolean;
  } = {},
) {
  const lectura = {
    conversacionesDelPeriodo: jest.fn(() =>
      Promise.resolve(opciones.filas ?? []),
    ),
  };
  const ajustes = {
    leer: jest.fn(() =>
      Promise.resolve(
        Object.assign(ajustesDeLaBandejaPorDefecto(A), opciones.ajustes),
      ),
    ),
  };
  const redis = {
    get: jest.fn(() =>
      opciones.redisRoto
        ? Promise.reject(new Error('sin Redis'))
        : Promise.resolve(opciones.cache ?? null),
    ),
    setex: jest.fn(() =>
      opciones.redisRoto
        ? Promise.reject(new Error('sin Redis'))
        : Promise.resolve(),
    ),
  };
  const servicio = new TiempoEsperadoService(
    lectura as unknown as MetricasReadModel,
    ajustes as unknown as CompanyChatSettingsService,
    redis as unknown as RedisService,
  );
  return { servicio, lectura, redis };
}

describe('TiempoEsperadoService (7c)', () => {
  it('con historia suficiente: la mediana hábil de los últimos 14 días del canal, y la guarda 10 minutos', async () => {
    const filas = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(respondida);
    const { servicio, lectura, redis } = armar({ filas });
    const t = await servicio.delCanal(A, Channel.STAFF_CUSTOMER, AHORA);
    expect([t.minutes, t.basis, t.text]).toEqual([
      10,
      'history',
      'Solemos responder en ~10 min',
    ]);
    expect(lectura.conversacionesDelPeriodo).toHaveBeenCalledWith(
      A,
      [Channel.STAFF_CUSTOMER],
      { desde: new Date(AHORA.getTime() - 14 * 86_400_000), hasta: AHORA },
    );
    expect(redis.setex).toHaveBeenCalledWith(
      claveDelTiempoEsperado(A, Channel.STAFF_CUSTOMER),
      TTL_DEL_TIEMPO_ESPERADO_SEG,
      JSON.stringify({
        respondidas: 11,
        esperando: 0,
        mediana: 10,
        medianaDeEspera: null,
      }),
    );
  });

  it('las abiertas que esperan entran con lo que llevan esperando (en minutos hábiles); las cerradas sin respuesta, no', async () => {
    const esperando = (horas: number, i: number): ConversacionDelPeriodo => ({
      ...respondida(0, i),
      conversationId: `e-${i}`,
      status: ConversationStatus.OPEN,
      firstIncomingAt: new Date(AHORA.getTime() - horas * 3_600_000),
      firstResponseAt: null,
    });
    const filas = [
      ...[5, 6, 7].map(respondida),
      ...[2, 2, 2, 2, 2, 2, 2].map(esperando),
      { ...esperando(9, 99), status: ConversationStatus.CLOSED },
    ];
    const { servicio, redis } = armar({ filas });
    const t = await servicio.delCanal(A, Channel.STAFF_CUSTOMER, AHORA);
    // 3 respondidas + 7 esperando hace 2 h: la mediana de las 10 es 120.
    expect([t.minutes, t.basis]).toEqual([120, 'history']);
    expect(redis.setex).toHaveBeenCalledWith(
      expect.any(String),
      TTL_DEL_TIEMPO_ESPERADO_SEG,
      JSON.stringify({
        respondidas: 3,
        esperando: 7,
        mediana: 120,
        medianaDeEspera: 120,
      }),
    );
  });

  it('pocos datos: el objetivo de la empresa', async () => {
    const { servicio } = armar({
      filas: [3, 4].map(respondida),
      ajustes: { firstResponseTargetMinutes: 20 },
    });
    const t = await servicio.delCanal(A, Channel.STAFF_DRIVER, AHORA);
    expect([t.minutes, t.basis]).toEqual([20, 'target']);
  });

  it('con la historia en caché no consulta la base', async () => {
    const { servicio, lectura } = armar({
      cache: JSON.stringify({
        respondidas: 40,
        esperando: 0,
        mediana: 4,
        medianaDeEspera: null,
      }),
    });
    const t = await servicio.delCanal(A, Channel.STAFF_CUSTOMER, AHORA);
    expect([t.minutes, t.basis]).toEqual([4, 'history']);
    expect(lectura.conversacionesDelPeriodo).not.toHaveBeenCalled();
  });

  it('si Redis falla, se calcula igual', async () => {
    const { servicio, lectura } = armar({ redisRoto: true });
    const t = await servicio.delCanal(A, Channel.STAFF_CUSTOMER, AHORA);
    expect([t.enabled, t.basis]).toEqual([true, 'target']);
    expect(lectura.conversacionesDelPeriodo).toHaveBeenCalled();
  });

  it('apagado por la empresa: nada, sin leer la historia', async () => {
    const { servicio, lectura, redis } = armar({
      ajustes: { expectedReplyEnabled: false },
    });
    const t = await servicio.delCanal(A, Channel.STAFF_DRIVER, AHORA);
    expect(t).toEqual(expect.objectContaining({ enabled: false, text: null }));
    expect(lectura.conversacionesDelPeriodo).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('con el chat de clientes apagado: al cliente nada; al chofer sí', async () => {
    const { servicio } = armar({ ajustes: { customerChatEnabled: false } });
    expect(
      (await servicio.delCanal(A, Channel.STAFF_CUSTOMER, AHORA)).enabled,
    ).toBe(false);
    expect(
      (await servicio.delCanal(A, Channel.STAFF_DRIVER, AHORA)).enabled,
    ).toBe(true);
  });

  it('la caché es por empresa y canal', () => {
    expect(claveDelTiempoEsperado(A, Channel.STAFF_CUSTOMER)).not.toBe(
      claveDelTiempoEsperado('empresa-b', Channel.STAFF_CUSTOMER),
    );
    expect(claveDelTiempoEsperado(A, Channel.STAFF_CUSTOMER)).not.toBe(
      claveDelTiempoEsperado(A, Channel.STAFF_DRIVER),
    );
  });
});
