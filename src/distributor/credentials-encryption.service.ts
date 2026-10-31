import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Cifra los secretos que se guardan en la base (credenciales propias de cada
 * distribuidora). AES-256-GCM con un IV aleatorio por valor; lo guardado es
 * `base64(iv | tag | texto cifrado)`. La clave es `CREDENTIALS_ENCRYPTION_KEY`
 * (32 bytes en base64) y es opcional: sin ella no se pueden cargar credenciales
 * y todo el sistema sigue con la cuenta del entorno.
 */
@Injectable()
export class CredentialsEncryptionService {
  constructor(private readonly config: ConfigService) {}

  /** `true` si hay una clave válida para cifrar y descifrar. */
  isConfigured(): boolean {
    return this.readKey() !== null;
  }

  encrypt(value: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      'base64',
    );
  }

  /** Lanza si el valor no es válido o fue alterado (el tag de autenticación no cierra). */
  decrypt(value: string): string {
    const payload = Buffer.from(value, 'base64');
    if (payload.length <= IV_BYTES + TAG_BYTES) {
      throw new ServiceUnavailableException(
        'La credencial guardada es inválida',
      );
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key(),
        payload.subarray(0, IV_BYTES),
      );
      decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        'No se pudo descifrar la credencial: fue alterada o la clave de cifrado cambió',
      );
    }
  }

  private key(): Buffer {
    const key = this.readKey();
    if (!key) {
      throw new ServiceUnavailableException(
        'Las credenciales propias no están habilitadas: falta CREDENTIALS_ENCRYPTION_KEY',
      );
    }
    return key;
  }

  private readKey(): Buffer | null {
    const raw = this.config.get<string>('CREDENTIALS_ENCRYPTION_KEY');
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  }
}
