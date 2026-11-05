import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DocumentReadingProposalService,
  impactoDe,
} from './document-reading-proposal.service';
import {
  DocumentReading,
  DocumentReadingStatus,
} from './entities/document-reading.entity';

const reading = (status = DocumentReadingStatus.READ): DocumentReading =>
  ({
    readingId: 'r1',
    distributorId: 'd1',
    status,
    proposal: null,
    proposalExpiresAt: null,
    remindedAt: null,
    escalatedAt: null,
  }) as unknown as DocumentReading;
const proposal = {
  action: 'review' as const,
  ownerType: 'employee',
  ownerId: 'o1',
  expected: {},
  read: {},
  differences: [],
  summary: 'Revisar',
};

describe('DocumentReadingProposalService', () => {
  let repo: { find: jest.Mock; update: jest.Mock };
  let reconciliation: { conciliar: jest.Mock };
  let settings: { parametros: jest.Mock };
  let events: { emit: jest.Mock };
  let service: DocumentReadingProposalService;
  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    reconciliation = { conciliar: jest.fn().mockResolvedValue(proposal) };
    settings = {
      parametros: jest.fn().mockResolvedValue({
        proposalTtlHours: 48,
        reminderTtlHours: 24,
        batchSize: 10,
      }),
    };
    events = { emit: jest.fn() };
    service = new DocumentReadingProposalService(
      repo as never,
      reconciliation as never,
      settings as never,
      events as unknown as EventEmitter2,
    );
  });
  it('guarda propuesta y avisa al terminar una lectura', async () => {
    const result = await service.procesarLectura(
      reading(),
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(result).toMatchObject({
      status: DocumentReadingStatus.PROPOSED,
      proposal,
      proposalExpiresAt: new Date('2026-01-03T00:00:00Z'),
    });
    expect(events.emit).toHaveBeenCalled();
  });
  it('avisa documento ilegible sin propuesta', async () => {
    await service.procesarLectura(reading(DocumentReadingStatus.UNREADABLE));
    expect(repo.update).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalled();
  });
  it('recuerda una vez y luego escala sin repetir', async () => {
    const pending = {
      ...reading(DocumentReadingStatus.PROPOSED),
      proposal,
      proposalExpiresAt: new Date('2025-12-31T00:00:00Z'),
      remindedAt: null,
      escalatedAt: null,
    } as DocumentReading;
    repo.find.mockResolvedValue([pending]);
    await expect(
      service.vencerDeDistribuidora('d1', new Date('2026-01-01T00:00:00Z')),
    ).resolves.toEqual({ reminders: 1, escalations: 0 });
    pending.proposalExpiresAt = new Date('2025-12-31T00:00:00Z');
    pending.remindedAt = new Date('2026-01-01T00:00:00Z');
    await expect(
      service.vencerDeDistribuidora('d1', new Date('2026-01-02T00:00:00Z')),
    ).resolves.toEqual({ reminders: 0, escalations: 1 });
    pending.escalatedAt = new Date('2026-01-02T00:00:00Z');
    repo.find.mockResolvedValue([]);
    await expect(
      service.vencerDeDistribuidora('d1', new Date('2026-01-03T00:00:00Z')),
    ).resolves.toEqual({ reminders: 0, escalations: 0 });
    expect(events.emit).toHaveBeenCalledTimes(2);
    const llamadas = events.emit.mock.calls as Array<
      [string, { email?: boolean; body: string }]
    >;
    const escalado = llamadas[1][1];
    expect(escalado.email).toBe(true);
    expect(escalado.body).toContain('El documento sigue sin revisarse.');
  });
  it('no avisa si otra operación ya concilió la lectura', async () => {
    repo.update.mockResolvedValue({ affected: 0 });
    await service.procesarLectura(reading());
    expect(events.emit).not.toHaveBeenCalled();
  });
  it('barre sólo lecturas ya leídas sin conciliar y sigue tras un error', async () => {
    const primera = reading();
    const segunda = { ...reading(), readingId: 'r2' };
    repo.find.mockResolvedValue([primera, segunda]);
    reconciliation.conciliar
      .mockRejectedValueOnce(new Error('caída'))
      .mockResolvedValueOnce(proposal);
    await expect(
      service.procesarPendientesDeDistribuidora(
        'd1',
        new Date('2026-01-01T00:15:00Z'),
      ),
    ).resolves.toBe(1);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, order: { readAt: 'ASC' } }),
    );
    const [{ where }] = repo.find.mock.calls[0] as [
      {
        where: {
          distributorId: string;
          status: { value: string[] };
          reconciledAt: { type: string };
          readAt: { type: string; value: Date };
        };
      },
    ];
    expect(where.distributorId).toBe('d1');
    expect(where.status.value).toEqual([
      DocumentReadingStatus.READ,
      DocumentReadingStatus.UNREADABLE,
      DocumentReadingStatus.DUPLICATE,
    ]);
    expect(where.reconciledAt.type).toBe('isNull');
    // 15 minutos de margen para que el admin termine el pago a mano.
    expect(where.readAt.type).toBe('lessThanOrEqual');
    expect(where.readAt.value).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ readingId: 'r2' }),
      expect.any(Object),
    );
  });
  it('revalida una propuesta resuelta y la devuelve a leída sin avisar', async () => {
    const pending = {
      ...reading(DocumentReadingStatus.PROPOSED),
      proposal,
      proposalExpiresAt: new Date('2025-12-31T00:00:00Z'),
      remindedAt: null,
      escalatedAt: null,
    };
    repo.find.mockResolvedValue([pending]);
    reconciliation.conciliar.mockResolvedValue(null);
    await expect(
      service.vencerDeDistribuidora('d1', new Date('2026-01-01T00:00:00Z')),
    ).resolves.toEqual({ reminders: 0, escalations: 0 });
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: DocumentReadingStatus.PROPOSED }),
      expect.objectContaining({
        status: DocumentReadingStatus.READ,
        proposal: null,
        proposalExpiresAt: null,
      }),
    );
    expect(events.emit).not.toHaveBeenCalled();
  });
  it('si una vencida no se puede volver a conciliar, sigue con las demás y enlaza al panel', async () => {
    const vencida = (id: string) => ({
      ...reading(DocumentReadingStatus.PROPOSED),
      readingId: id,
      proposal,
      proposalExpiresAt: new Date('2025-12-31T00:00:00Z'),
      remindedAt: null,
      escalatedAt: null,
    });
    repo.find.mockResolvedValue([vencida('r1'), vencida('r2')]);
    reconciliation.conciliar
      .mockRejectedValueOnce(new Error('base caída'))
      .mockResolvedValueOnce(proposal);
    await expect(
      service.vencerDeDistribuidora('d1', new Date('2026-01-01T00:00:00Z')),
    ).resolves.toEqual({ reminders: 1, escalations: 0 });
    const llamadas = events.emit.mock.calls as Array<
      [string, { link: { entity: string; id: string } }]
    >;
    expect(llamadas[0][1].link).toEqual({
      entity: 'document-reading',
      id: 'r2',
    });
  });
  it('marca y avisa un duplicado sin proponerlo', async () => {
    await service.procesarLectura(reading(DocumentReadingStatus.DUPLICATE));
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: DocumentReadingStatus.DUPLICATE }),
      expect.objectContaining({ reconciledAt: expect.anything() as unknown }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: 'document_reading_notice' }),
    );
  });
  it('el aviso escalado dice el impacto de cada acción', () => {
    const base = { ...proposal, differences: [] };
    expect(
      impactoDe({
        ...base,
        action: 'pay_installment',
        expected: { importe: '150000.00', destinatario: 'La Segunda' },
      }),
    ).toBe('La cuota de $150.000,00 de La Segunda sigue impaga.');
    expect(
      impactoDe({
        ...base,
        action: 'update_policy',
        expected: { numero_de_poliza: 'P-77' },
      }),
    ).toContain('La póliza P-77');
    expect(
      impactoDe({ ...base, action: 'register_purchase_invoice', expected: {} }),
    ).toBe('La factura de compra por el importe sigue sin registrarse.');
  });
});
