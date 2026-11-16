import type { DataSource } from 'typeorm';
import { PlatformSupportSettings } from '../entities/platform-support-settings.entity';
import { UpdateSupportSettingsDto } from '../presentation/dto/support-settings.dto';
import {
  configuracionPorDefecto,
  CUPO_MAYOR_QUE_EL_TOTAL,
  SupportSettingsService,
} from './support-settings.service';

function armar(guardada: PlatformSupportSettings | null = null) {
  const guardados: PlatformSupportSettings[] = [];
  const repo = {
    findOne: jest.fn(() => Promise.resolve(guardada)),
    save: jest.fn((c: PlatformSupportSettings) => {
      guardados.push(c);
      return Promise.resolve(c);
    }),
  };
  const manager = { getRepository: jest.fn(() => repo) };
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  return {
    servicio: new SupportSettingsService(dataSource as unknown as DataSource),
    guardados,
  };
}

/** Como llega del `ValidationPipe`: una instancia con los campos que no vinieron en `undefined`. */
const dto = (campos: Partial<UpdateSupportSettingsDto>) =>
  Object.assign(new UpdateSupportSettingsDto(), campos);

describe('SupportSettingsService: el asistente con IA del soporte y sus topes (B3)', () => {
  it('por omisión: apagado, 10 respuestas por conversación y 2.000.000 tokens por mes', () => {
    expect(configuracionPorDefecto()).toMatchObject({
      assistantAiEnabled: false,
      assistantRepliesPerConversation: 10,
      assistantMonthlyTokenLimit: 2_000_000,
      assistantMonthlyTokenLimitPerCompany: 2_000_000,
    });
  });

  it('guarda sólo lo que vino: lo demás queda como estaba', async () => {
    const actual = Object.assign(configuracionPorDefecto(), {
      chatHours: [{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }],
      assistantMonthlyTokenLimit: 500_000,
      assistantMonthlyTokenLimitPerCompany: 200_000,
    });
    const { servicio, guardados } = armar(actual);
    await servicio.actualizar(
      'plat-1',
      dto({ assistantAiEnabled: true, assistantRepliesPerConversation: 5 }),
    );
    expect(guardados[0]).toMatchObject({
      assistantAiEnabled: true,
      assistantRepliesPerConversation: 5,
      assistantMonthlyTokenLimit: 500_000,
      chatHours: [{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }],
      chatInactivityHours: 24,
      updatedByUserId: 'plat-1',
    });
  });

  it.each([
    [{ assistantRepliesPerConversation: 0 }],
    [{ assistantRepliesPerConversation: 51 }],
    [{ assistantRepliesPerConversation: 2.5 }],
    [{ assistantMonthlyTokenLimit: 9_999 }],
    [{ assistantMonthlyTokenLimit: 1_000_000_001 }],
    [{ assistantMonthlyTokenLimitPerCompany: 9_999 }],
    [{ assistantMonthlyTokenLimitPerCompany: 1_000_000_001 }],
    [{ assistantMonthlyTokenLimitPerCompany: 15_000.5 }],
  ])(
    'segunda capa: un tope fuera de rango (%o) es 400 y no se guarda (por si llega sin pasar por el DTO)',
    async (campos) => {
      const { servicio, guardados } = armar();
      await expect(
        servicio.actualizar('plat-1', dto(campos)),
      ).rejects.toMatchObject({ status: 400 });
      expect(guardados).toEqual([]);
    },
  );

  it.each([
    [
      'el cupo por empresa supera el total que viene en el mismo pedido',
      {},
      {
        assistantMonthlyTokenLimit: 100_000,
        assistantMonthlyTokenLimitPerCompany: 100_001,
      },
    ],
    [
      'el cupo por empresa supera el total guardado',
      { assistantMonthlyTokenLimit: 100_000 },
      { assistantMonthlyTokenLimitPerCompany: 100_001 },
    ],
    [
      'se baja el total por debajo del cupo guardado',
      {
        assistantMonthlyTokenLimit: 500_000,
        assistantMonthlyTokenLimitPerCompany: 300_000,
      },
      { assistantMonthlyTokenLimit: 299_999 },
    ],
  ])(
    'segunda capa: %s → 400 en castellano y no se guarda',
    async (_caso, guardado, campos) => {
      const { servicio, guardados } = armar(
        Object.assign(configuracionPorDefecto(), guardado),
      );
      await expect(
        servicio.actualizar('plat-1', dto(campos)),
      ).rejects.toMatchObject({
        status: 400,
        message: CUPO_MAYOR_QUE_EL_TOTAL,
      });
      expect(guardados).toEqual([]);
    },
  );

  it('el cupo igual al total vale (y bajar los dos juntos también)', async () => {
    const { servicio, guardados } = armar();
    await servicio.actualizar(
      'plat-1',
      dto({
        assistantMonthlyTokenLimit: 50_000,
        assistantMonthlyTokenLimitPerCompany: 50_000,
      }),
    );
    expect(guardados[0]).toMatchObject({
      assistantMonthlyTokenLimit: 50_000,
      assistantMonthlyTokenLimitPerCompany: 50_000,
    });
  });
});
