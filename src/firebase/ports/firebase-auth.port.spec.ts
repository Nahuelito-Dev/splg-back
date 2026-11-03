import { BadRequestException } from '@nestjs/common';
import { auth } from 'firebase-admin';
import { FirebaseAuthPort } from './firebase-auth.port';

class PuertoDePrueba extends FirebaseAuthPort {
  createUser = jest.fn<Promise<auth.UserRecord>, [auth.CreateRequest]>();
  verifyIdToken = jest.fn();
  getUserByEmail = jest.fn();
  deleteUser = jest.fn();
  updateUser = jest.fn();
  generatePasswordResetLink = jest.fn();
}

describe('FirebaseAuthPort.createUserSafe', () => {
  let puerto: PuertoDePrueba;

  beforeEach(() => {
    puerto = new PuertoDePrueba();
  });

  it.each([
    [
      'auth/invalid-password',
      'La contraseña es muy débil: usá al menos 6 caracteres',
    ],
    ['auth/email-already-exists', 'Ese correo ya está registrado'],
    ['auth/phone-number-already-exists', 'El teléfono ya está en uso'],
    ['auth/invalid-email', 'El formato del correo no es válido'],
    [
      'auth/invalid-phone-number',
      'El formato del teléfono no es válido: usá el formato E.164, por ejemplo +5493764000000',
    ],
  ])('%s responde un 400 en castellano', async (code, mensaje) => {
    puerto.createUser.mockRejectedValue({ code, message: 'texto del SDK' });

    const error: unknown = await puerto
      .createUserSafe({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(mensaje);
  });

  it('un código desconocido responde un texto genérico, sin el detalle del SDK', async () => {
    puerto.createUser.mockRejectedValue({
      code: 'auth/internal-error',
      message: 'proyecto splg-gas: detalle interno',
    });

    const error: unknown = await puerto
      .createUserSafe({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      'No se pudo crear la cuenta',
    );
  });

  it('un error sin código también responde el texto genérico', async () => {
    puerto.createUser.mockRejectedValue(new Error('red caída'));

    await expect(puerto.createUserSafe({})).rejects.toThrow(
      'No se pudo crear la cuenta',
    );
  });
});
