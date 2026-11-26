import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { NotificationChannel, NotificationStatus } from './domain/aviso';
import { NotificationLog } from './entities/notification-log.entity';
import { NotificationLogRecorder } from './notification-log.recorder';

function armar(distribuidoraDelPedido: string | null = 'dist-del-pedido') {
  const repo = {
    insert: jest.fn().mockResolvedValue(undefined),
    query: jest
      .fn()
      .mockResolvedValue(
        distribuidoraDelPedido
          ? [{ distributor_id: distribuidoraDelPedido }]
          : [],
      ),
  };
  const recorder = new NotificationLogRecorder(
    repo as unknown as Repository<NotificationLog>,
  );
  return { recorder, repo };
}

/** Deja correr el registro, que sale en segundo plano. */
const vaciar = () => new Promise<void>((resolver) => setImmediate(resolver));

const aviso = {
  channel: NotificationChannel.EMAIL,
  destino: 'nahuel@dominio.com',
  titulo: 'Tu pedido',
  contexto: {
    type: 'ORDER_CONFIRMATION',
    orderId: 'o1',
    recipientUserId: 'u1',
  },
};

describe('NotificationLogRecorder', () => {
  afterEach(() => jest.restoreAllMocks());

  it('un envío que sale queda como sent, con el destino enmascarado y la distribuidora del pedido', async () => {
    const { recorder, repo } = armar();
    await expect(
      recorder.conRegistro(aviso, () => Promise.resolve(7)),
    ).resolves.toBe(7);
    await vaciar();
    expect(repo.insert).toHaveBeenCalledWith({
      distributorId: 'dist-del-pedido',
      channel: 'email',
      type: 'ORDER_CONFIRMATION',
      recipientUserId: 'u1',
      recipientMasked: 'n***@dominio.com',
      subject: 'Tu pedido',
      status: 'sent',
      error: null,
      relatedOrderId: 'o1',
    });
  });

  it('la distribuidora que pasa el que envía manda sobre la del pedido y no se consulta', async () => {
    const { recorder, repo } = armar();
    await recorder.conRegistro(
      { ...aviso, contexto: { ...aviso.contexto, distributorId: 'dist-x' } },
      () => Promise.resolve(1),
    );
    await vaciar();
    expect(repo.query).not.toHaveBeenCalled();
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ distributorId: 'dist-x' }),
    );
  });

  it('sin distribuidora explícita busca la del pedido y deja una advertencia en el log', async () => {
    const { recorder, repo } = armar();
    const advertencia = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await recorder.conRegistro(aviso, () => Promise.resolve(1));
    await vaciar();
    expect(repo.query).toHaveBeenCalledTimes(1);
    expect(advertencia).toHaveBeenCalledWith(
      expect.stringContaining('sin distribuidora'),
    );
  });

  it('un push guarda sólo los últimos 6 del token y sin tipo queda UNKNOWN', async () => {
    const { recorder, repo } = armar();
    await recorder.conRegistro(
      { channel: NotificationChannel.PUSH, destino: 'abc:APA91bXYZ123456' },
      () => Promise.resolve('id'),
    );
    await vaciar();
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientMasked: '***123456',
        type: 'UNKNOWN',
        distributorId: null,
        relatedOrderId: null,
      }),
    );
  });

  it('si el envío falla queda failed con el error y el error se vuelve a lanzar', async () => {
    const { recorder, repo } = armar();
    await expect(
      recorder.conRegistro(aviso, () =>
        Promise.reject(new Error('token inválido')),
      ),
    ).rejects.toThrow('token inválido');
    await vaciar();
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'token inválido' }),
    );
  });

  it('si el envío no tuvo efecto queda con el estado y el motivo que informa', async () => {
    const { recorder, repo } = armar();
    await recorder.conRegistro(
      aviso,
      () => Promise.resolve(false),
      (salio) =>
        salio
          ? null
          : { status: NotificationStatus.SKIPPED, error: 'sin configurar' },
    );
    await vaciar();
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', error: 'sin configurar' }),
    );
  });

  it('un insert que tarda no demora el envío', async () => {
    const { recorder, repo } = armar();
    let terminarInsert: () => void = () => undefined;
    repo.insert.mockReturnValue(
      new Promise<void>((resolver) => {
        terminarInsert = resolver;
      }),
    );
    // Si el envío esperara el insert, esta promesa no se resolvería nunca.
    await expect(
      recorder.conRegistro(
        { ...aviso, contexto: { ...aviso.contexto, distributorId: 'd' } },
        () => Promise.resolve('listo'),
      ),
    ).resolves.toBe('listo');
    expect(repo.insert).toHaveBeenCalledTimes(1);
    terminarInsert();
  });

  it('si falla el insert del registro, el envío no se rompe y el fallo se loguea', async () => {
    const { recorder, repo } = armar();
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    repo.insert.mockRejectedValue(new Error('base caída'));
    await expect(
      recorder.conRegistro(aviso, () => Promise.resolve('listo')),
    ).resolves.toBe('listo');
    await vaciar();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('No se pudo registrar el aviso'),
    );
  });

  it('si falla el insert y el envío también, se lanza el error del envío', async () => {
    const { recorder, repo } = armar();
    repo.insert.mockRejectedValue(new Error('base caída'));
    await expect(
      recorder.conRegistro(aviso, () => Promise.reject(new Error('FCM'))),
    ).rejects.toThrow('FCM');
    await vaciar();
  });

  it('si falla buscar la distribuidora del pedido el aviso igual queda registrado, sin distribuidora', async () => {
    const { recorder, repo } = armar();
    repo.query.mockRejectedValue(new Error('timeout'));
    await expect(
      recorder.conRegistro(aviso, () => Promise.resolve('listo')),
    ).resolves.toBe('listo');
    await vaciar();
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ distributorId: null, relatedOrderId: 'o1' }),
    );
  });
});
