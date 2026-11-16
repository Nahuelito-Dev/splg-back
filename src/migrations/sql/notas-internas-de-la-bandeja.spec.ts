import type { QueryRunner } from 'typeorm';
import { NotasInternasDeLaBandeja1795000000123 } from '../1795000000123-NotasInternasDeLaBandeja';
import { FRENAR_SI_HAY_NOTAS } from './notas-internas-de-la-bandeja';

describe('NotasInternasDeLaBandeja: deshacer (down)', () => {
  it('lo primero es frenar si hay notas, menciones o avisos para una persona: nada se convierte ni se borra', async () => {
    const sentencias: string[] = [];
    const runner = {
      query: jest.fn((sql: string) => {
        sentencias.push(sql);
        return Promise.resolve();
      }),
    } as unknown as QueryRunner;
    await new NotasInternasDeLaBandeja1795000000123().down(runner);
    expect(sentencias[0]).toBe(FRENAR_SI_HAY_NOTAS);
    for (const condicion of [
      `"visibility" = 'internal' AND "sender_party" IN ('company', 'system')`,
      'EXISTS (SELECT 1 FROM "message_mention")',
      `"recipient_user_id" IS NOT NULL`,
      'RAISE EXCEPTION',
    ]) {
      expect(FRENAR_SI_HAY_NOTAS).toContain(condicion);
    }
    // Nunca vuelve visibles las notas ni las borra.
    expect(sentencias.join('\n')).not.toMatch(
      /UPDATE "message"|DELETE FROM "message"/,
    );
  });

  it('si el freno falla (hay datos), no sigue con nada más', async () => {
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('No se puede deshacer …'));
    await expect(
      new NotasInternasDeLaBandeja1795000000123().down({
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow('No se puede deshacer');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
