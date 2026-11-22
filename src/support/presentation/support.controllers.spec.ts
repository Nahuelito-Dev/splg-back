import { SupportSessionStatus } from '../domain/support-session.enums';
import { SupportSession } from '../entities/support-session.entity';
import { User } from '../../users/entities/user.entity';
import type { SupportAccessService } from '../application/support-access.service';
import type { SupportSessionsService } from '../application/support-sessions.service';
import { CreateSupportSessionDto } from './dto/create-support-session.dto';
import { SupportAccessController } from './support-access.controller';
import { SupportSessionsController } from './support-sessions.controller';
import { SupportSessionPresenter } from './support-session.presenter';
import type { EntityPhotoService } from '../../s3/entity-photo.service';

/** El presenter real con una firma de mentira: `photoKey` → URL. */
const urlDe = jest.fn((key: string | null | undefined) =>
  Promise.resolve(key ? `https://s3.test/${key}?firma` : null),
);
const presentar = new SupportSessionPresenter({
  urlDe,
} as unknown as EntityPhotoService);

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
    presentar,
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
    presentar,
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

describe('SupportSessionPresenter: la foto de quien pide, decide y termina', () => {
  const persona = (photoKey: string | null) =>
    Object.assign(new User(), { photoKey });
  const sesion = (extra: Partial<SupportSession>) =>
    Object.assign(new SupportSession(), SESION, extra);

  beforeEach(() => urlDe.mockClear());

  it('con foto: sale la URL firmada de cada persona; sin foto, null', async () => {
    const [dto] = await presentar.sesiones([
      sesion({
        requestedBy: 'u1',
        requester: persona('users/u1/a.jpg'),
        decidedBy: 'a1',
        decider: persona(null),
        endedBy: 'u1',
        ender: persona('users/u1/a.jpg'),
      }),
    ]);
    expect(dto.requestedBy).toEqual({
      userId: 'u1',
      fullName: null,
      photoUrl: 'https://s3.test/users/u1/a.jpg?firma',
    });
    expect(dto.decidedBy?.photoUrl).toBeNull();
    expect(dto.endedBy?.photoUrl).toBe('https://s3.test/users/u1/a.jpg?firma');
  });

  it('firma una vez por persona aunque pida varias sesiones de la página (sin N+1)', async () => {
    const dtos = await presentar.sesiones([
      sesion({ requestedBy: 'u1', requester: persona('k1') }),
      sesion({ requestedBy: 'u1', requester: persona('k1') }),
      sesion({ requestedBy: 'u2', requester: persona('k2') }),
    ]);
    expect(urlDe).toHaveBeenCalledTimes(2);
    expect(dtos.map((d) => d.requestedBy.photoUrl)).toEqual([
      'https://s3.test/k1?firma',
      'https://s3.test/k1?firma',
      'https://s3.test/k2?firma',
    ]);
  });

  it('una persona que no vino cargada (cuenta dada de baja): null, sin firmar', async () => {
    const dto = await presentar.sesion(sesion({ requestedBy: 'u9' }));
    expect(dto.requestedBy.photoUrl).toBeNull();
    expect(urlDe).not.toHaveBeenCalled();
  });

  it('los controllers de la plataforma y de la empresa devuelven la foto', async () => {
    const conFoto = sesion({ requestedBy: 'u1', requester: persona('k1') });
    const plataforma = new SupportSessionsController(
      {
        listar: jest.fn().mockResolvedValue({ items: [conFoto], total: 1 }),
      } as unknown as SupportSessionsService,
      presentar,
    );
    const empresa = new SupportAccessController(
      {
        listar: jest.fn().mockResolvedValue({ items: [conFoto], total: 1 }),
      } as unknown as SupportAccessService,
      {} as unknown as SupportSessionsService,
      presentar,
    );
    const esperado = {
      items: [{ requestedBy: { photoUrl: 'https://s3.test/k1?firma' } }],
    };
    await expect(
      plataforma.listar({ limit: 20, offset: 0 }),
    ).resolves.toMatchObject(esperado);
    await expect(
      empresa.listar('d1', { limit: 20, offset: 0 }),
    ).resolves.toMatchObject(esperado);
  });
});
