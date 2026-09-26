import { HttpException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { AuthService } from './auth.service';
import { AdminService } from '../admin/admin.service';
import { UsersService } from '../users/users.service';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';

jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(() => ({})),
  signInWithEmailAndPassword: jest.fn(),
}));

/**
 * El acceso lo resuelve Firebase; el servicio decide lo que es nuestro: que la
 * cuenta siga habilitada, qué sale en la respuesta (sin refreshToken) y qué
 * dice el 401 cuando el token no sirve.
 */
describe('AuthService', () => {
  let service: AuthService;
  let users: { findOneByEmail: jest.Mock };
  let admins: { findOneByEmail: jest.Mock };
  let firebase: { verifyIdToken: jest.Mock };
  const signIn = signInWithEmailAndPassword as jest.Mock;

  const credencial = {
    user: {
      uid: 'uid-1',
      email: 'ana@splg.com',
      displayName: null,
      phoneNumber: null,
      emailVerified: true,
      refreshToken: 'no-tiene-que-salir',
      getIdTokenResult: jest.fn().mockResolvedValue({
        token: 'token-1',
        expirationTime: new Date(Date.now() + 3600_000).toUTCString(),
      }),
    },
  };

  beforeEach(() => {
    users = { findOneByEmail: jest.fn() };
    admins = { findOneByEmail: jest.fn() };
    firebase = { verifyIdToken: jest.fn() };
    signIn.mockReset();
    service = new AuthService(
      { get: () => undefined } as unknown as ConfigService,
      admins as unknown as AdminService,
      users as unknown as UsersService,
      firebase as unknown as FirebaseAuthPort,
    );
  });

  it('POST /auth conserva la forma histórica de la respuesta', () => {
    expect({ ...service.checkIfTokenValid() }).toEqual({
      response: 'token valid',
      status: 100,
      message: 'token valid',
      name: 'HttpException',
    });
  });

  it('el login devuelve el token y el usuario, sin refreshToken', async () => {
    signIn.mockResolvedValue(credencial);
    users.findOneByEmail.mockResolvedValue({ blocked: false });

    const sesion = await service.login({
      email: 'ana@splg.com',
      password: 'x',
    });

    expect(sesion.accessToken).toBe('token-1');
    expect(sesion.expiresIn).toBeGreaterThan(3500);
    expect(sesion.user.uid).toBe('uid-1');
    expect(JSON.stringify(sesion)).not.toContain('no-tiene-que-salir');
  });

  it('credenciales incorrectas son un 400', async () => {
    signIn.mockRejectedValue(new Error('auth/invalid-credential'));
    await expect(
      service.login({ email: 'ana@splg.com', password: 'mal' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('una cuenta deshabilitada en Firebase es 401, sin el texto de Firebase', async () => {
    signIn.mockRejectedValue(
      Object.assign(new Error('Firebase: Error (auth/user-disabled).'), {
        code: 'auth/user-disabled',
      }),
    );
    await expect(
      service.login({ email: 'ana@splg.com', password: 'x' }),
    ).rejects.toThrow(
      new UnauthorizedException('La cuenta no está habilitada'),
    );
  });

  it('una cuenta bloqueada no recibe token', async () => {
    signIn.mockResolvedValue(credencial);
    users.findOneByEmail.mockResolvedValue({ blocked: true });
    await expect(
      service.login({ email: 'ana@splg.com', password: 'x' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('una cuenta dada de baja no recibe token', async () => {
    signIn.mockResolvedValue(credencial);
    users.findOneByEmail.mockRejectedValue(new Error('no existe'));
    await expect(
      service.login({ email: 'ana@splg.com', password: 'x' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un token inválido es un 401 que conserva el code de Firebase', async () => {
    firebase.verifyIdToken.mockRejectedValue({
      code: 'auth/id-token-expired',
      message: 'expiró',
    });
    const error = await service.decodeToken('viejo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      statusCode: 401,
      code: 'auth/id-token-expired',
    });
  });

  it('el panel rechaza a quien no es administrador', async () => {
    firebase.verifyIdToken.mockResolvedValue({
      email: 'cliente@splg.com',
      uid: 'u',
      sub: 'u',
    });
    admins.findOneByEmail.mockRejectedValue(new Error('no existe'));
    await expect(service.loginDashboard('t')).rejects.toThrow(
      'Admin not found',
    );
  });
});
