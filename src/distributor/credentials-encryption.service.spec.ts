import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { CredentialsEncryptionService } from './credentials-encryption.service';

const claveDePrueba = (): string => randomBytes(32).toString('base64');

const crear = (clave?: string): CredentialsEncryptionService =>
  new CredentialsEncryptionService({
    get: () => clave,
  } as unknown as ConfigService);

describe('CredentialsEncryptionService', () => {
  it('descifra lo que cifró', () => {
    const servicio = crear(claveDePrueba());

    const cifrado = servicio.encrypt('APP_USR-1234');

    expect(cifrado).not.toContain('APP_USR');
    expect(servicio.decrypt(cifrado)).toBe('APP_USR-1234');
  });

  it('el mismo valor cifrado dos veces da distinto resultado (IV aleatorio)', () => {
    const servicio = crear(claveDePrueba());

    expect(servicio.encrypt('x'.repeat(20))).not.toBe(
      servicio.encrypt('x'.repeat(20)),
    );
  });

  it('un valor alterado no se descifra (tag de autenticación)', () => {
    const servicio = crear(claveDePrueba());
    const bytes = Buffer.from(servicio.encrypt('secreto-largo-1234'), 'base64');
    bytes[bytes.length - 1] ^= 1;

    expect(() => servicio.decrypt(bytes.toString('base64'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('con otra clave no se descifra', () => {
    const cifrado = crear(claveDePrueba()).encrypt('secreto');

    expect(() => crear(claveDePrueba()).decrypt(cifrado)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('un valor demasiado corto es inválido', () => {
    expect(() => crear(claveDePrueba()).decrypt('AAAA')).toThrow(
      ServiceUnavailableException,
    );
  });

  it('sin clave (o con una de largo incorrecto) no está habilitado y no cifra', () => {
    expect(crear().isConfigured()).toBe(false);
    expect(crear(randomBytes(16).toString('base64')).isConfigured()).toBe(
      false,
    );
    expect(() => crear().encrypt('x')).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });
});
