/**
 * Tiempo del tablero de la empresa con 1000 conversaciones de esperas largas
 * (180 días, horario partido y feriados). Corre aparte y en serie (`npm run
 * test:perf`, parte de `npm run verify`) para que la carga de otros tests en
 * paralelo no falsee la medición.
 */
import { Channel, ConversationStatus } from '../domain/chat.enums';
import type {
  ConversacionDelPeriodo,
  MetricasReadModel,
} from '../infrastructure/metricas-read-model';
import { ChatMetricsService } from './chat-metrics.service';
import {
  ajustesDeLaBandejaPorDefecto,
  type CompanyChatSettingsService,
} from './company-chat-settings.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const DIA = 86_400_000;
const AHORA = new Date('2026-11-16T15:00:00Z');

/** 1000 conversaciones: la mitad respondida a los 180 días, un cuarto esperando desde hace 180, un cuarto cerrada sin respuesta. */
function conversaciones(): ConversacionDelPeriodo[] {
  return Array.from({ length: 1000 }, (_, i) => {
    const desde = new Date(AHORA.getTime() - 360 * DIA + i * 60_000);
    const tipo = i % 4;
    return {
      channel: i % 2 === 0 ? Channel.STAFF_CUSTOMER : Channel.STAFF_DRIVER,
      status: tipo === 3 ? ConversationStatus.CLOSED : ConversationStatus.OPEN,
      createdAt: desde,
      firstIncomingAt:
        tipo === 2 ? new Date(AHORA.getTime() - 180 * DIA) : desde,
      firstResponseAt: tipo < 2 ? new Date(desde.getTime() + 180 * DIA) : null,
      closedAt: tipo === 3 ? new Date(desde.getTime() + DIA) : null,
      closedReason: tipo === 3 ? 'manual' : null,
    };
  });
}

describe('ChatMetricsService: tiempo', () => {
  it('1000 conversaciones con esperas de 180 días se resumen en menos de 5 segundos', async () => {
    const filas = conversaciones();
    const lectura = {
      conversacionesDelPeriodo: jest.fn(() => Promise.resolve(filas)),
      enVivo: jest.fn(() => Promise.resolve([])),
      usoDePlantillas: jest.fn(() => Promise.resolve([])),
      encuestas: jest.fn(() => Promise.resolve([])),
    };
    const ajustes = {
      leer: jest.fn(() =>
        Promise.resolve(
          Object.assign(ajustesDeLaBandejaPorDefecto(EMPRESA), {
            businessHours: [1, 2, 3, 4, 5].flatMap((weekday) => [
              { weekday, opensAt: '08:00', closesAt: '12:00' },
              { weekday, opensAt: '14:00', closesAt: '20:00' },
            ]),
            holidays: [
              { date: '2026-07-09', reason: 'Independencia' },
              { date: '2026-08-17', reason: 'San Martín' },
            ],
          }),
        ),
      ),
      asistenteConIaDisponible: jest.fn(() => Promise.resolve(false)),
    };
    const s = new ChatMetricsService(
      lectura as unknown as MetricasReadModel,
      ajustes as unknown as CompanyChatSettingsService,
    );
    const t0 = Date.now();
    const m = await s.deLaEmpresa(
      EMPRESA,
      { from: '2025-11-17', to: '2026-11-16' },
      AHORA,
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(m.firstResponse).toEqual(
      expect.objectContaining({
        responded: 500,
        unanswered: 250,
        closedWithoutHumanReply: 250,
      }),
    );
    expect(m.firstResponse.target).toEqual({
      met: 0,
      missed: 750,
      rate: 0,
    });
    expect(m.daily).toHaveLength(365);
  });
});
