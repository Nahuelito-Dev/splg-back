import { ConflictException } from '@nestjs/common';
import {
  Attachment,
  AttachmentOwnerType,
} from '../attachment/entities/attachment.entity';
import { TipoDeDocumento } from '../document-reader/tipos-de-documento';
import {
  nuevaCorrida,
  dentroDeCorrida,
} from '../process-run/process-run.context';
import { RedisService } from '../redis/redis.service';
import { S3Service } from '../s3/s3.service';
import { DocumentReadingStatus } from './entities/document-reading.entity';
import { DocumentReadingQueueService } from './document-reading-queue.service';
import {
  COSTO_ESTIMADO_POR_OMISION_USD,
  costoEstimado,
  DocumentReadingRunnerService,
} from './document-reading-runner.service';
import { DocumentReadingService } from './document-reading.service';
import { DocumentReadingSettingsService } from './document-reading-settings.service';

const attachment = (
  id: string,
  ownerType = AttachmentOwnerType.INSURANCE_INSTALLMENT,
) =>
  ({
    attachmentId: id,
    storageKey: `key/${id}`,
    mimeType: 'application/pdf',
    ownerType,
  }) as Attachment;
const params = {
  enabled: true,
  frequencyMinutes: 15,
  batchSize: 10,
  maxAttempts: 3,
  monthlyBudgetUsd: 20,
  typesMask: 255,
};

describe('DocumentReadingRunnerService', () => {
  let settings: { parametros: jest.Mock };
  let queue: { pendientes: jest.Mock };
  let readings: {
    disponible: boolean;
    gastoDelMes: jest.Mock;
    leerAdjunto: jest.Mock;
    registrarFalloPrevio: jest.Mock;
  };
  let s3: { get: jest.Mock };
  let redis: { withLock: jest.Mock };
  let runner: DocumentReadingRunnerService;

  beforeEach(() => {
    settings = { parametros: jest.fn().mockResolvedValue(params) };
    queue = { pendientes: jest.fn().mockResolvedValue([attachment('a1')]) };
    readings = {
      disponible: true,
      gastoDelMes: jest.fn().mockResolvedValue({ lecturas: 0, costoUsd: 0 }),
      leerAdjunto: jest.fn().mockResolvedValue({
        registro: { status: DocumentReadingStatus.READ },
      }),
      registrarFalloPrevio: jest.fn().mockResolvedValue({}),
    };
    s3 = { get: jest.fn().mockResolvedValue(Buffer.from('pdf')) };
    redis = {
      withLock: jest.fn(<T>(_k: string, _t: number, fn: () => Promise<T>) =>
        fn().then((valor) => ({ obtenido: true as const, valor })),
      ),
    };
    runner = new DocumentReadingRunnerService(
      settings as unknown as DocumentReadingSettingsService,
      queue as unknown as DocumentReadingQueueService,
      readings as unknown as DocumentReadingService,
      s3 as unknown as S3Service,
      redis as unknown as RedisService,
    );
  });

  it('rechaza una corrida manual apagada salvo dryRun o ignoreEnabled', async () => {
    settings.parametros.mockResolvedValue({ ...params, enabled: false });
    await expect(runner.run('d1')).rejects.toBeInstanceOf(ConflictException);
    await expect(runner.run('d1', { dryRun: true })).resolves.toMatchObject({
      read: 1,
    });
    await expect(
      runner.run('d1', { ignoreEnabled: true }),
    ).resolves.toMatchObject({ read: 1 });
  });

  it('dryRun cuenta sin bajar S3 ni leer', async () => {
    await expect(runner.run('d1', { dryRun: true })).resolves.toEqual({
      distributors: 1,
      read: 1,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      budgetReached: 0,
    });
    expect(s3.get).not.toHaveBeenCalled();
    expect(readings.leerAdjunto).not.toHaveBeenCalled();
  });

  it('corta al alcanzar el presupuesto y con tope cero no lee nada', async () => {
    readings.gastoDelMes.mockResolvedValue({ lecturas: 0, costoUsd: 20 });
    await expect(runner.run('d1')).resolves.toMatchObject({
      budgetReached: 1,
      read: 0,
    });
    expect(s3.get).not.toHaveBeenCalled();
    settings.parametros.mockResolvedValue({ ...params, monthlyBudgetUsd: 0 });
    await expect(runner.run('d1')).resolves.toMatchObject({
      budgetReached: 1,
      read: 0,
    });
  });

  it('sigue con el lote y registra el error de un adjunto', async () => {
    queue.pendientes.mockResolvedValue([attachment('a1'), attachment('a2')]);
    s3.get.mockRejectedValueOnce(new Error('S3 caída'));
    const corrida = nuevaCorrida();
    await dentroDeCorrida(corrida, () => runner.run('d1'));
    expect(readings.leerAdjunto).toHaveBeenCalledTimes(1);
    expect(corrida.errors).toBe(1);
  });

  it.each([
    [
      DocumentReadingStatus.READ,
      { read: 1, duplicates: 0, failed: 0, skipped: 0 },
    ],
    [
      DocumentReadingStatus.UNREADABLE,
      { read: 1, duplicates: 0, failed: 0, skipped: 0 },
    ],
    [
      DocumentReadingStatus.DUPLICATE,
      { read: 0, duplicates: 1, failed: 0, skipped: 0 },
    ],
    [
      DocumentReadingStatus.FAILED,
      { read: 0, duplicates: 0, failed: 1, skipped: 0 },
    ],
    [
      DocumentReadingStatus.PENDING,
      { read: 0, duplicates: 0, failed: 0, skipped: 1 },
    ],
  ])('cuenta el estado %s', async (status, expected) => {
    readings.leerAdjunto.mockResolvedValue({ registro: { status } });
    await expect(runner.run('d1')).resolves.toMatchObject(expected);
  });

  it('pasa al lector el tipo esperado del dueño', async () => {
    await runner.run('d1');
    expect(readings.leerAdjunto).toHaveBeenCalledWith(
      expect.objectContaining({
        opciones: { tipoEsperado: TipoDeDocumento.COMPROBANTE_DE_PAGO },
      }),
    );
  });

  it('si el archivo no está en S3, registra el fallo con un motivo legible', async () => {
    s3.get.mockRejectedValueOnce(
      new Error('The specified key does not exist.'),
    );
    await expect(runner.run('d1')).resolves.toMatchObject({ failed: 1 });
    expect(readings.leerAdjunto).not.toHaveBeenCalled();
    expect(readings.registrarFalloPrevio).toHaveBeenCalledWith({
      distributorId: 'd1',
      attachmentId: 'a1',
      motivo: 'El archivo no está en el almacenamiento: subilo de nuevo',
    });
  });

  it('si registrar el fallo también falla, la corrida sigue', async () => {
    s3.get.mockRejectedValueOnce(new Error('timeout'));
    readings.registrarFalloPrevio.mockRejectedValueOnce(
      new Error('base caída'),
    );
    await expect(runner.run('d1')).resolves.toMatchObject({ failed: 1 });
  });

  it('una corrida a la vez por distribuidora: con el cerrojo tomado, 409 sin leer', async () => {
    redis.withLock.mockResolvedValueOnce({ obtenido: false });
    await expect(runner.run('d1')).rejects.toThrow('en curso');
    expect(readings.leerAdjunto).not.toHaveBeenCalled();
    expect(redis.withLock).toHaveBeenCalledWith(
      'document-reading:corrida:d1',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('sin el servicio de lectura configurado, 503 y no baja nada', async () => {
    readings.disponible = false;
    await expect(runner.run('d1')).rejects.toThrow('no está configurado');
    expect(s3.get).not.toHaveBeenCalled();
  });

  it('no empieza una lectura que por su costo promedio pasaría el tope', async () => {
    settings.parametros.mockResolvedValue({ ...params, monthlyBudgetUsd: 1 });
    // 2 lecturas por US$ 0,80: promedio 0,40; 0,80 + 0,40 > 1.
    readings.gastoDelMes.mockResolvedValue({ lecturas: 2, costoUsd: 0.8 });
    await expect(runner.run('d1')).resolves.toMatchObject({
      read: 0,
      budgetReached: 1,
    });
    expect(readings.leerAdjunto).not.toHaveBeenCalled();
  });

  it('un documento que otro pedido está leyendo se saltea, no cuenta como fallo', async () => {
    readings.leerAdjunto.mockRejectedValueOnce(
      new ConflictException('se está leyendo'),
    );
    await expect(runner.run('d1')).resolves.toMatchObject({
      skipped: 1,
      failed: 0,
    });
    expect(readings.registrarFalloPrevio).not.toHaveBeenCalled();
  });

  it('dryRun respeta el tope: no promete más lecturas de las que caben', async () => {
    queue.pendientes.mockResolvedValue([
      attachment('a1'),
      attachment('a2'),
      attachment('a3'),
    ]);
    settings.parametros.mockResolvedValue({ ...params, monthlyBudgetUsd: 1 });
    readings.gastoDelMes.mockResolvedValue({ lecturas: 1, costoUsd: 0.4 });
    await expect(runner.run('d1', { dryRun: true })).resolves.toMatchObject({
      read: 1,
      budgetReached: 1,
    });
  });
});

describe('costoEstimado', () => {
  it('es el promedio del mes, o el de omisión si no hay lecturas', () => {
    expect(costoEstimado(0.9, 3)).toBeCloseTo(0.3);
    expect(costoEstimado(0, 0)).toBe(COSTO_ESTIMADO_POR_OMISION_USD);
  });
});
