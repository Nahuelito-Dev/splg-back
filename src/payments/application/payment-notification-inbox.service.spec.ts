import { EVENTO_PAGO_NOTIFICADO } from '../domain/events/pago-notificado.event';
import { getMetadataArgsStorage } from 'typeorm';
import { PaymentNotificationInbox } from '../entities/payment-notification-inbox.entity';
import { PaymentNotificationInboxService } from './payment-notification-inbox.service';

describe('bandeja de avisos: clave única (A-1)', () => {
  it('deduplica por tipo, recurso Y cuenta: una alerta falsa de otra cuenta no tapa a la verdadera', () => {
    const indices = getMetadataArgsStorage().indices.filter(
      (i) => i.target === PaymentNotificationInbox && i.unique,
    );
    const columnas = indices.map((i) => ({
      columns: i.columns,
      where: i.where,
    }));
    expect(columnas).toContainEqual({
      columns: ['type', 'dataId', 'credentialId'],
      where: '"credential_id" IS NOT NULL',
    });
    // La cuenta del sistema (sin credencial) tiene su propio único: NULL no compara igual.
    expect(columnas).toContainEqual({
      columns: ['type', 'dataId'],
      where: '"credential_id" IS NULL',
    });
    expect(columnas).not.toContainEqual({
      columns: ['type', 'dataId'],
      where: undefined,
    });
  });
});

describe('PaymentNotificationInboxService (M-4)', () => {
  let bandeja: {
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
    delete?: jest.Mock;
  };
  let pagos: { findOne: jest.Mock };
  let eventos: { emitAsync: jest.Mock; emit: jest.Mock };
  let service: PaymentNotificationInboxService;

  const fila = (over: Record<string, unknown> = {}) => ({
    notification_id: 'n-1',
    type: 'stop_delivery_op_wh',
    data_id: '58980959081',
    credential_id: null,
    attempts: 1,
    ...over,
  });

  beforeEach(() => {
    bandeja = {
      save: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((x: unknown) => x),
      update: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([[fila()], 1]),
    };
    pagos = {
      findOne: jest
        .fn()
        .mockResolvedValue({ distributorId: 'dist-1', orderId: 'ord-1' }),
    };
    eventos = {
      emitAsync: jest.fn().mockResolvedValue([]),
      emit: jest.fn(),
    };
    service = new PaymentNotificationInboxService(
      bandeja as never,
      pagos as never,
      eventos as never,
      { get: (_k: string, d: number) => d } as never,
    );
  });

  it('B-4: la toma del lote incrementa los intentos y corre el turno en la misma sentencia SQL (lease), con SKIP LOCKED', async () => {
    await service.procesarPendientes();

    const sql = (bandeja.query.mock.calls[0] as [string])[0];
    expect(sql).toContain('"attempts" = "attempts" + 1');
    expect(sql).toContain('"next_attempt_at" = now() +');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('B-5: purga los procesados viejos (parámetro de días) y nunca los fallidos, que son la evidencia', async () => {
    bandeja.delete = jest.fn().mockResolvedValue({ affected: 3 });

    await expect(service.purgarProcesados()).resolves.toBe(3);

    const [criterio] = bandeja.delete.mock.calls[0] as [
      { status: string; processedAt: { _value: Date } },
    ];
    expect(criterio.status).toBe('processed');
    const dias =
      (Date.now() - criterio.processedAt._value.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThan(89.9);
    expect(dias).toBeLessThan(90.1);
  });

  it('guarda el aviso crudo', async () => {
    await service.guardar({
      type: 'stop_delivery_op_wh',
      dataId: '1',
      credentialId: 'c',
      rawBody: { a: 1 },
    });

    expect(bandeja.save).toHaveBeenCalledWith({
      type: 'stop_delivery_op_wh',
      dataId: '1',
      credentialId: 'c',
      rawBody: { a: 1 },
    });
  });

  it('el mismo aviso otra vez (único por tipo y recurso) no es un error', async () => {
    bandeja.save.mockRejectedValue({ code: '23505' });

    await expect(
      service.guardar({ type: 'stop_delivery_op_wh', dataId: '1' }),
    ).resolves.toBeUndefined();
  });

  it('otro error al guardar se propaga (el webhook contesta 503)', async () => {
    bandeja.save.mockRejectedValue(new Error('base caída'));

    await expect(
      service.guardar({ type: 'stop_delivery_op_wh', dataId: '1' }),
    ).rejects.toThrow('base caída');
  });

  it('procesa el pendiente por el mismo camino del webhook y lo marca procesado', async () => {
    await expect(service.procesarPendientes()).resolves.toBe(1);

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      EVENTO_PAGO_NOTIFICADO,
      expect.objectContaining({
        type: 'stop_delivery_op_wh',
        dataId: '58980959081',
      }),
    );
    expect(bandeja.update).toHaveBeenCalledWith(
      { notificationId: 'n-1' },
      expect.objectContaining({ status: 'processed' }),
    );
  });

  it('si falla, lo deja pendiente con espera creciente y el error, sin avisar todavía', async () => {
    eventos.emitAsync.mockRejectedValue(new Error('MP caído'));

    await service.procesarPendientes();

    const [, cambios] = bandeja.update.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(cambios).toMatchObject({ lastError: 'MP caído' });
    // El contador lo incrementa la toma del lote en SQL, no este update.
    expect(cambios).not.toHaveProperty('attempts');
    expect(cambios).not.toHaveProperty('status');
    expect(
      (cambios.nextAttemptAt as Date).getTime() - Date.now(),
    ).toBeGreaterThan(25_000);
    expect(eventos.emit).not.toHaveBeenCalled();
  });

  it('la espera se duplica en cada intento hasta un tope', async () => {
    eventos.emitAsync.mockRejectedValue(new Error('x'));
    bandeja.query.mockResolvedValue([[fila({ attempts: 5 })], 1]);

    await service.procesarPendientes();

    const [, cambios] = bandeja.update.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    // intento 5 → 30 s * 2^4 = 480 s
    expect(
      (cambios.nextAttemptAt as Date).getTime() - Date.now(),
    ).toBeGreaterThan(470_000);
  });

  it('agotados los intentos pasa a failed y avisa al administrador (con mail)', async () => {
    eventos.emitAsync.mockRejectedValue(new Error('sigue roto'));
    bandeja.query.mockResolvedValue([
      [
        fila({
          attempts: PaymentNotificationInboxService.INTENTOS_MAXIMOS,
        }),
      ],
      1,
    ]);

    await service.procesarPendientes();

    expect(bandeja.update).toHaveBeenCalledWith(
      { notificationId: 'n-1' },
      expect.objectContaining({ status: 'failed' }),
    );
    const [, aviso] = eventos.emit.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(aviso).toMatchObject({
      distributorId: 'dist-1',
      kind: 'payment_alert_unprocessed',
    });
  });

  it('un fallo no frena a los demás avisos del lote', async () => {
    bandeja.query.mockResolvedValue([
      [fila(), fila({ notification_id: 'n-2', data_id: '2' })],
      2,
    ]);
    eventos.emitAsync
      .mockRejectedValueOnce(new Error('uno falla'))
      .mockResolvedValueOnce([]);

    await expect(service.procesarPendientes()).resolves.toBe(1);
  });
});
