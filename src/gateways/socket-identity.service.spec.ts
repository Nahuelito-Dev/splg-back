import { SocketIdentityService } from './socket-identity.service';
import { SocketDeSplg, tokenDelHandshake } from './socket-data';
import { UsersService } from '../users/users.service';
import { AuthService } from '../auth/auth.service';

/**
 * La identidad de un socket sale del token y de la base, nunca de lo que el
 * cliente manda en el mensaje: es lo que impide meterse en la sala de otro.
 */
describe('SocketIdentityService', () => {
  let service: SocketIdentityService;
  let users: { findOneWithRoleByEmail: jest.Mock };
  let auth: { decodeToken: jest.Mock };

  const socket = (
    auth: Record<string, unknown> = {},
    authorization?: string,
  ): SocketDeSplg =>
    ({
      handshake: { auth, headers: authorization ? { authorization } : {} },
      data: {},
    }) as unknown as SocketDeSplg;

  beforeEach(() => {
    users = { findOneWithRoleByEmail: jest.fn() };
    auth = { decodeToken: jest.fn() };
    service = new SocketIdentityService(
      users as unknown as UsersService,
      auth as unknown as AuthService,
    );
  });

  it('toma el token de auth.token o de la cabecera Authorization', () => {
    expect(tokenDelHandshake(socket({ token: 'a' }))).toBe('a');
    expect(tokenDelHandshake(socket({}, 'Bearer b'))).toBe('b');
    expect(tokenDelHandshake(socket())).toBeNull();
  });

  it('sin token no hay identidad', async () => {
    await expect(service.identificar(socket())).resolves.toBeNull();
    expect(auth.decodeToken).not.toHaveBeenCalled();
  });

  it('con token inválido no hay identidad', async () => {
    auth.decodeToken.mockRejectedValue(new Error('vencido'));
    await expect(
      service.identificar(socket({ token: 't' })),
    ).resolves.toBeNull();
  });

  it('un usuario bloqueado no entra', async () => {
    auth.decodeToken.mockResolvedValue({ email: 'ana@splg.com' });
    users.findOneWithRoleByEmail.mockResolvedValue({
      userId: 'u1',
      blocked: true,
    });
    await expect(
      service.identificar(socket({ token: 't' })),
    ).resolves.toBeNull();
  });

  it('resuelve la identidad real y la guarda en socket.data', async () => {
    auth.decodeToken.mockResolvedValue({ email: 'ana@splg.com' });
    users.findOneWithRoleByEmail.mockResolvedValue({
      userId: 'u1',
      blocked: false,
      role: { type: 'customer' },
    });
    const s = socket({ token: 't' });

    const identidad = await service.identificar(s);

    expect(identidad).toEqual({
      userId: 'u1',
      email: 'ana@splg.com',
      role: 'customer',
      distributorId: null,
    });
    expect(s.data.identidad).toEqual(identidad);
  });

  it('resuelve la distribuidora del admin desde su perfil (admins[0])', async () => {
    auth.decodeToken.mockResolvedValue({ email: 'admin@splg.com' });
    users.findOneWithRoleByEmail.mockResolvedValue({
      userId: 'u2',
      blocked: false,
      role: { type: 'admin' },
      admins: [{ distributorId: 'dist-1' }],
    });

    const identidad = await service.identificar(socket({ token: 't' }));

    expect(identidad?.distributorId).toBe('dist-1');
  });

  it('resuelve la distribuidora del chofer desde su perfil delivery', async () => {
    auth.decodeToken.mockResolvedValue({ email: 'chofer@splg.com' });
    users.findOneWithRoleByEmail.mockResolvedValue({
      userId: 'u3',
      blocked: false,
      role: { type: 'delivery' },
      delivery: { distributorId: 'dist-2' },
    });

    const identidad = await service.identificar(socket({ token: 't' }));

    expect(identidad?.distributorId).toBe('dist-2');
  });

  it('el super_admin no tiene una sola distribuidora (null)', async () => {
    auth.decodeToken.mockResolvedValue({ email: 'super@splg.com' });
    users.findOneWithRoleByEmail.mockResolvedValue({
      userId: 'u4',
      blocked: false,
      role: { type: 'super_admin' },
    });

    const identidad = await service.identificar(socket({ token: 't' }));

    expect(identidad?.distributorId).toBeNull();
  });

  it('obtener no vuelve a consultar la base si ya está resuelta', async () => {
    const s = socket({ token: 't' });
    s.data.identidad = {
      userId: 'u1',
      email: 'a',
      role: 'customer' as never,
      distributorId: null,
    };
    await service.obtener(s);
    expect(auth.decodeToken).not.toHaveBeenCalled();
  });
});
