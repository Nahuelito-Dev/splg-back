import { SupportSessionStatus } from '../domain/support-session.enums';
import { SupportSession } from '../entities/support-session.entity';
import type { SupportAccessService } from '../application/support-access.service';
import type { SupportSessionsService } from '../application/support-sessions.service';
import { CreateSupportSessionDto } from './dto/create-support-session.dto';
import { SupportAccessController } from './support-access.controller';
import { SupportSessionsController } from './support-sessions.controller';

const SESION = Object.assign(new SupportSession(), {
  supportSessionId: 's1',
  distributorId: 'd1',
  requestedBy: 'u1',
  status: SupportSessionStatus.PENDING,
  scope: [],
  requestExpiresAt: null,
  decidedAt: null,
  startedAt: null,
  expiresAt: null,
  endedAt: null,
  createdAt: new Date('2026-11-13T12:00:00Z'),
});

describe('SupportSessionsController', () => {
  const service = {
    pedir: jest.fn().mockResolvedValue(SESION),
    actual: jest.fn(),
    listar: jest.fn().mockResolvedValue({ items: [SESION], total: 1 }),
    ficha: jest.fn().mockResolvedValue(SESION),
    accesos: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    terminar: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new SupportSessionsController(
    service as unknown as SupportSessionsService,
  );

  it('pedir pasa el usuario y devuelve el DTO', async () => {
    const dto = new CreateSupportSessionDto();
    await expect(controller.pedir('u1', dto)).resolves.toMatchObject({
      id: 's1',
      status: 'pending',
    });
    expect(service.pedir).toHaveBeenCalledWith('u1', dto);
  });

  it('la actual: null si no hay', async () => {
    service.actual.mockResolvedValueOnce(null);
    await expect(controller.actual('u1')).resolves.toEqual({ session: null });
    service.actual.mockResolvedValueOnce(SESION);
    await expect(controller.actual('u1')).resolves.toMatchObject({
      session: { id: 's1' },
    });
  });

  it('listar, ficha y accesos devuelven DTOs', async () => {
    await expect(
      controller.listar({ limit: 20, offset: 0 }),
    ).resolves.toMatchObject({ total: 1, items: [{ id: 's1' }] });
    await expect(controller.ficha('s1')).resolves.toMatchObject({ id: 's1' });
    await expect(
      controller.accesos('s1', { limit: 20, offset: 0 }),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  it('terminar acepta el cuerpo vacío', async () => {
    await controller.terminar(
      'u1',
      's1',
      undefined as unknown as Record<string, never>,
    );
    expect(service.terminar).toHaveBeenCalledWith('u1', 's1', {});
  });
});

describe('SupportAccessController', () => {
  const service = {
    listar: jest.fn().mockResolvedValue({ items: [SESION], total: 1 }),
    aprobar: jest.fn().mockResolvedValue(SESION),
    rechazar: jest.fn().mockResolvedValue(SESION),
    revocar: jest.fn().mockResolvedValue(SESION),
    politica: jest
      .fn()
      .mockResolvedValue({ emergencyAllowed: true, autoApprove: false }),
    actualizarPolitica: jest
      .fn()
      .mockResolvedValue({ emergencyAllowed: false, autoApprove: false }),
  };
  const sesiones = {
    ficha: jest.fn().mockResolvedValue(SESION),
    accesos: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const controller = new SupportAccessController(
    service as unknown as SupportAccessService,
    sesiones as unknown as SupportSessionsService,
  );

  it('todo va acotado a la distribuidora del admin', async () => {
    await controller.listar('d1', { limit: 20, offset: 0 });
    expect(service.listar).toHaveBeenCalledWith('d1', {
      limit: 20,
      offset: 0,
    });
    await controller.ficha('d1', 's1');
    expect(sesiones.ficha).toHaveBeenCalledWith('s1', 'd1');
    await controller.accesos('d1', 's1', { limit: 5, offset: 0 });
    expect(sesiones.accesos).toHaveBeenCalledWith(
      's1',
      { limit: 5, offset: 0 },
      'd1',
    );
    await controller.aprobar('d1', 'a1', 's1', {});
    expect(service.aprobar).toHaveBeenCalledWith('d1', 'a1', 's1', {});
    await controller.rechazar('d1', 'a1', 's1', {});
    expect(service.rechazar).toHaveBeenCalledWith('d1', 'a1', 's1', {});
    await controller.revocar('d1', 'a1', 's1');
    expect(service.revocar).toHaveBeenCalledWith('d1', 'a1', 's1');
  });

  it('la política se lee y se cambia en la empresa del admin', async () => {
    await expect(controller.politica('d1')).resolves.toEqual({
      emergencyAllowed: true,
      autoApprove: false,
    });
    await controller.actualizarPolitica('d1', { emergencyAllowed: false });
    expect(service.actualizarPolitica).toHaveBeenCalledWith('d1', {
      emergencyAllowed: false,
    });
  });
});
