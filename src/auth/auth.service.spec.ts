import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signInWithEmailAndPassword } from 'firebase/auth';
import {
  AuthService,
  MENSAJE_CREDENCIALES,
  MENSAJE_TOKEN_INVALIDO,
  MENSAJE_TOKEN_VENCIDO,
} from './auth.service';
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

  describe('credenciales incorrectas', () => {
    const conCodigo = (code: string) =>
      Object.assign(new Error(`Firebase: Error (${code}).`), { code });
    const intentar = () =>
      service
        .login({ email: 'ana@splg.com', password: 'mal' })
        .catch((e: unknown) => e) as Promise<UnauthorizedException>;

    it.each([
      'auth/invalid-credential',
      'auth/wrong-password',
      'auth/user-not-found',
      'auth/invalid-email',
    ])(
      '%s es 401 con un mensaje propio, sin el texto de Firebase',
      async (code) => {
        signIn.mockRejectedValue(conCodigo(code));
        const error = await intentar();
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.message).toBe('El email o la contraseña son incorrectos');
        expect(error.message).not.toContain('Firebase');
      },
    );

    it('usuario inexistente y contraseña equivocada responden exactamente lo mismo', async () => {
      signIn.mockRejectedValue(conCodigo('auth/user-not-found'));
      const inexistente = await intentar();
      signIn.mockRejectedValue(conCodigo('auth/wrong-password'));
      const equivocada = await intentar();
      expect(inexistente.getResponse()).toEqual(equivocada.getResponse());
    });

    it('demasiados intentos es 429 y otro error del proveedor es 503, sin su texto', async () => {
      signIn.mockRejectedValue(conCodigo('auth/too-many-requests'));
      const limite = await intentar();
      expect(limite.getStatus()).toBe(429);
      signIn.mockRejectedValue(
        new Error('Firebase: Error (auth/network-request-failed).'),
      );
      const caido = await intentar();
      expect(caido.getStatus()).toBe(503);
      expect(caido.message).not.toContain('Firebase');
    });
  });

  it('una cuenta deshabilitada en Firebase es 401 con la misma respuesta que una credencial mala, sin revelar que existe', async () => {
    signIn.mockRejectedValue(
      Object.assign(new Error('Firebase: Error (auth/user-disabled).'), {
        code: 'auth/user-disabled',
      }),
    );
    await expect(
      service.login({ email: 'ana@splg.com', password: 'x' }),
    ).rejects.toThrow(new UnauthorizedException(MENSAJE_CREDENCIALES));
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

  it('un token mal formado responde con un mensaje propio, sin el texto interno de Firebase', async () => {
    firebase.verifyIdToken.mockRejectedValue(
      Object.assign(
        new Error(
          'Decoding Firebase ID token failed. See https://firebase.google.com/docs/auth/admin/verify-id-tokens',
        ),
        { code: 'auth/argument-error' },
      ),
    );
    const error = await service.decodeToken('basura').catch((e: unknown) => e);
    const cuerpo = (error as UnauthorizedException).getResponse();
    expect(cuerpo).toMatchObject({
      statusCode: 401,
      message: MENSAJE_TOKEN_INVALIDO,
      code: 'auth/argument-error',
    });
    expect(JSON.stringify(cuerpo)).not.toMatch(/firebase/i);
  });

  it('un token vencido dice que venció', async () => {
    firebase.verifyIdToken.mockRejectedValue({
      code: 'auth/id-token-expired',
      message: 'Firebase ID token has expired',
    });
    const error = await service.decodeToken('viejo').catch((e: unknown) => e);
    expect((error as UnauthorizedException).getResponse()).toMatchObject({
      message: MENSAJE_TOKEN_VENCIDO,
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
      'Administrador no encontrado',
    );
  });
});
