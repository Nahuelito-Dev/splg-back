import type { EntityManager } from 'typeorm';
import type { AccesoDeLaEmpresa } from '../../platform/access/acceso-de-la-empresa.service';
import { AsistenteDelChat } from './asistente-del-chat';
import type { CompanyChatSettingsService } from './company-chat-settings.service';
import type { SupportSettingsService } from './support-settings.service';

describe('AsistenteDelChat: apagar el interruptor de las empresas que perdieron la función (vencimiento)', () => {
  it('apaga sólo las que lo tienen prendido y ya no tienen la función', async () => {
    const habilitadas = new Set(['con-funcion']);
    const acceso = {
      habilitado: jest.fn((id: string) => Promise.resolve(habilitadas.has(id))),
    };
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.startsWith('SELECT')
          ? [{ distributor_id: 'con-funcion' }, { distributor_id: 'vencida' }]
          : [],
      ),
    );
    const chat = new AsistenteDelChat(
      acceso as unknown as AccesoDeLaEmpresa,
      {} as CompanyChatSettingsService,
      {} as SupportSettingsService,
    );
    expect(
      await chat.apagarDondeNoEstaHabilitado({
        query,
      } as unknown as EntityManager),
    ).toBe(1);
    expect(acceso.habilitado).toHaveBeenCalledWith('vencida', 'assistant');
    const updates = query.mock.calls.filter(([sql]) =>
      sql.startsWith('UPDATE'),
    );
    expect(updates).toEqual([
      [expect.stringContaining('"assistant_ai_enabled" = false'), ['vencida']],
    ]);
  });
});
