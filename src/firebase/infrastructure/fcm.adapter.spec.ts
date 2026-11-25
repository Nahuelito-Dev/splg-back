import { ConfigService } from '@nestjs/config';
import { app } from 'firebase-admin';
import { NotificationLogRecorder } from '../../notification-log/notification-log.recorder';
import { FcmAdapter } from './fcm.adapter';

describe('FcmAdapter', () => {
  const registro = {
    conRegistro: jest.fn(
      (
        _aviso: unknown,
        enviar: () => Promise<string>,
        evaluar?: (id: string) => unknown,
      ) => {
        evaluador = evaluar;
        return enviar();
      },
    ),
  };
  let evaluador: ((id: string) => unknown) | undefined;
  const adapter = (send: jest.Mock, timeoutMs?: string) =>
    new FcmAdapter(
      { messaging: () => ({ send }) } as unknown as app.App,
      {
        get: (clave: string) =>
          clave === 'FCM_TIMEOUT_MS' ? timeoutMs : undefined,
      } as unknown as ConfigService,
      registro as unknown as NotificationLogRecorder,
    );

  beforeEach(() => registro.conRegistro.mockClear());

  it('registra el push con el contexto explícito de quien envía', async () => {
    const send = jest.fn().mockResolvedValue('msg-1');
    const contexto = {
      type: 'ORDER_ARRIVED',
      orderId: 'o1',
      distributorId: 'd1',
      recipientUserId: 'u1',
    };
    await adapter(send).sendToToken(
      'tok-123456',
      { notification: { title: 'Llegó', body: 'b' } },
      contexto,
    );
    expect(registro.conRegistro).toHaveBeenCalledWith(
      {
        channel: 'push',
        destino: 'tok-123456',
        titulo: 'Llegó',
        contexto,
      },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('no deduce el tipo ni el pedido de message.data: sin contexto no hay dato', async () => {
    const send = jest.fn().mockResolvedValue('msg-1');
    await adapter(send).sendToToken('tok', {
      data: { type: 'TEST', event: 'X', orderId: 'o1' },
    });
    expect(registro.conRegistro).toHaveBeenCalledWith(
      expect.objectContaining({ contexto: undefined }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('un push sin messageId (FCM no confirmó a tiempo) se registra como failed', async () => {
    const send = jest.fn().mockResolvedValue('msg-1');
    await adapter(send).sendToToken('tok', {});
    expect(evaluador?.('msg-1')).toBeNull();
    expect(evaluador?.('')).toEqual({
      status: 'failed',
      error: expect.stringContaining('no confirmó') as string,
    });
  });

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
