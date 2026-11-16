import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { CashSessionController } from './cash-session.controller';
import { CashSessionV2Controller } from './cash-session-v2.controller';

describe('sesiones de caja en la API v2', () => {
  it('la vista previa vive en `/cash-sessions` versión 2 y la v1 sigue sin versión', () => {
    expect(Reflect.getMetadata(VERSION_METADATA, CashSessionV2Controller)).toBe(
      '2',
    );
    expect(Reflect.getMetadata(PATH_METADATA, CashSessionV2Controller)).toBe(
      'cash-sessions',
    );
    expect(
      Reflect.getMetadata(VERSION_METADATA, CashSessionController),
    ).toBeUndefined();
  });

  it('delega en el servicio con la distribuidora', async () => {
    const vistaPreviaDelCierre = jest.fn().mockResolvedValue({ difference: 1 });
    const c = new CashSessionV2Controller({
      vistaPreviaDelCierre,
    } as never);
    await c.vistaPrevia('s1', { countedAmount: 10 }, 'd1');
    expect(vistaPreviaDelCierre).toHaveBeenCalledWith(
      's1',
      { countedAmount: 10 },
      'd1',
    );
  });
});
