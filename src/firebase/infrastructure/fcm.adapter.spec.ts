import { ConfigService } from '@nestjs/config';
import { app } from 'firebase-admin';
import { FcmAdapter } from './fcm.adapter';

describe('FcmAdapter', () => {
  const adapter = (send: jest.Mock, timeoutMs?: string) =>
    new FcmAdapter(
      { messaging: () => ({ send }) } as unknown as app.App,
      {
        get: (clave: string) =>
          clave === 'FCM_TIMEOUT_MS' ? timeoutMs : undefined,
      } as unknown as ConfigService,
    );

  afterEach(() => jest.useRealTimers());

  it('devuelve el messageId del SDK con el token agregado', async () => {
    const send = jest.fn().mockResolvedValue('msg-1');
    await expect(
      adapter(send).sendToToken('tok', { data: { a: 'b' } }),
    ).resolves.toBe('msg-1');
    expect(send).toHaveBeenCalledWith({ data: { a: 'b' }, token: 'tok' });
  });

  it('si FCM no responde en el plazo configurado, sigue sin lanzar', async () => {
    jest.useFakeTimers();
    const send = jest.fn(() => new Promise<string>(() => undefined));
    const resultado = adapter(send as unknown as jest.Mock, '50').sendToToken(
      'tok',
      {},
    );
    await jest.advanceTimersByTimeAsync(60);
    await expect(resultado).resolves.toBe('');
  });

  it('el error del SDK dentro del plazo se propaga', async () => {
    const send = jest.fn().mockRejectedValue(new Error('token inválido'));
    await expect(adapter(send).sendToToken('tok', {})).rejects.toThrow(
      'token inválido',
    );
  });
});
