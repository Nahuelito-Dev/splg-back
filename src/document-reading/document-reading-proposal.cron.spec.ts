import { DistributorStatus } from '../distributor/entities/distributor.entity';
import {
  CorridaEnCurso,
  dentroDeCorrida,
  nuevaCorrida,
} from '../process-run/process-run.context';
import { DocumentReadingProposalCron } from './document-reading-proposal.cron';
import { empresasDePrueba } from '../process-run/testing/empresas-de-prueba';

describe('DocumentReadingProposalCron', () => {
  let proposals: {
    procesarPendientesDeDistribuidora: jest.Mock;
    vencerDeDistribuidora: jest.Mock;
  };
  let settings: { parametros: jest.Mock };
  let distributors: { findAll: jest.Mock };
  let redis: { withLock: jest.Mock };
  let cron: DocumentReadingProposalCron;
  let sinLector: Set<string>;

  beforeEach(() => {
    proposals = {
      procesarPendientesDeDistribuidora: jest.fn().mockResolvedValue(0),
      vencerDeDistribuidora: jest
        .fn()
        .mockResolvedValue({ reminders: 0, escalations: 0 }),
    };
    settings = { parametros: jest.fn().mockResolvedValue({ enabled: true }) };
    distributors = { findAll: jest.fn().mockResolvedValue([]) };
    redis = {
      withLock: jest.fn(async (_key, _ttl, work: () => Promise<void>) => {
        await work();
        return { obtenido: true };
      }),
    };
    sinLector = new Set();
    const kit = empresasDePrueba({
      distribuidoras: distributors as never,
      habilitado: (id, modulo) =>
        !(modulo === 'document_reading' && sinLector.has(id)),
    });
    cron = new DocumentReadingProposalCron(
      proposals as never,
      settings as never,
      redis as never,
      kit.empresas,
      kit.acceso,
    );
  });

  it('saltea distribuidoras inactivas o con lectura apagada', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'inactiva', status: DistributorStatus.SUSPENDED },
      { distributorId: 'apagada', status: DistributorStatus.ACTIVE },
    ]);
    settings.parametros.mockResolvedValue({ enabled: false });
    await cron.ejecutarSinCerrojo();
    // La suspendida ni siquiera consulta sus parámetros.
    expect(settings.parametros).not.toHaveBeenCalledWith('inactiva');
    expect(settings.parametros).toHaveBeenCalledWith('apagada');
    expect(proposals.procesarPendientesDeDistribuidora).not.toHaveBeenCalled();
    expect(proposals.vencerDeDistribuidora).not.toHaveBeenCalled();
  });

  it('un error de una distribuidora no corta las siguientes', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
      { distributorId: 'd2', status: DistributorStatus.ACTIVE },
    ]);
    proposals.procesarPendientesDeDistribuidora
      .mockRejectedValueOnce(new Error('caída'))
      .mockResolvedValueOnce(1);
    await cron.ejecutarSinCerrojo();
    expect(proposals.procesarPendientesDeDistribuidora).toHaveBeenCalledWith(
      'd2',
      expect.any(Date),
    );
  });

  const correr = async (fn: () => Promise<void>): Promise<CorridaEnCurso> => {
    const corrida = nuevaCorrida();
    await dentroDeCorrida(corrida, fn);
    return corrida;
  };

  it('marca saltada cuando no procesa lecturas ni vencimientos', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
    ]);
    const corrida = await correr(() => cron.ejecutarSinCerrojo());
    expect(proposals.vencerDeDistribuidora).toHaveBeenCalledWith(
      'd1',
      expect.any(Date),
    );
    expect(corrida.skipped).toBe(true);
  });

  it('con trabajo hecho no queda saltada', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
    ]);
    proposals.vencerDeDistribuidora.mockResolvedValue({
      reminders: 1,
      escalations: 0,
    });
    const corrida = await correr(() => cron.ejecutarSinCerrojo());
    expect(corrida.skipped).toBe(false);
  });

  it('con errores atrapados y nada procesado no queda saltada: el monitoreo la ve', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
    ]);
    settings.parametros.mockRejectedValue(new Error('base caída'));
    const corrida = await correr(() => cron.ejecutarSinCerrojo());
    expect(corrida.skipped).toBe(false);
    expect(corrida.errors).toBe(1);
  });

  it('termina sin trabajo si el cerrojo ya está tomado', async () => {
    redis.withLock.mockResolvedValue({ obtenido: false });
    const corrida = await correr(() => cron.ejecutar());
    expect(distributors.findAll).not.toHaveBeenCalled();
    expect(corrida.skipped).toBe(true);
  });

  it('con el lector deshabilitado por la plataforma no arma propuestas nuevas pero vence las que esperan', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
      { distributorId: 'd2', status: DistributorStatus.ACTIVE },
    ]);
    sinLector.add('d1');
    await cron.ejecutarSinCerrojo();
    expect(
      proposals.procesarPendientesDeDistribuidora,
    ).not.toHaveBeenCalledWith('d1', expect.any(Date));
    expect(proposals.procesarPendientesDeDistribuidora).toHaveBeenCalledWith(
      'd2',
      expect.any(Date),
    );
    expect(proposals.vencerDeDistribuidora).toHaveBeenCalledWith(
      'd1',
      expect.any(Date),
    );
  });

  it('si el lector se apaga después de elegir la empresa, no arma propuestas nuevas (re-consulta sin caché)', async () => {
    distributors.findAll.mockResolvedValue([
      { distributorId: 'd1', status: DistributorStatus.ACTIVE },
    ]);
    settings.parametros.mockImplementation((id: string) => {
      sinLector.add(id);
      return Promise.resolve({ enabled: true });
    });
    await cron.ejecutarSinCerrojo();
    expect(proposals.procesarPendientesDeDistribuidora).not.toHaveBeenCalled();
    expect(proposals.vencerDeDistribuidora).toHaveBeenCalledWith(
      'd1',
      expect.any(Date),
    );
  });
});
