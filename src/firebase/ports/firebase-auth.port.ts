import { BadRequestException, Logger } from '@nestjs/common';
import { auth } from 'firebase-admin';
import {
  errorCode,
  errorMessage as mensajeDe,
} from '../../common/errors/error-message';

/**
 * Datos para crear un usuario de Firebase Auth (email/password). Opcionales,
 * igual que `auth.CreateRequest` del SDK; el alta (`RegistroService`) los
 * manda todos.
 */
export interface CreateFirebaseUserProps {
  email?: string;
  password?: string;
  full_name?: string;
  phone_number?: string;
}

const logger = new Logger('FirebaseAuthPort');

const MENSAJES_DE_ALTA_EN_FIREBASE: Record<string, string> = {
  'auth/invalid-password':
    'La contraseña es muy débil: usá al menos 8 caracteres, una mayúscula, una minúscula y un número',
  'auth/email-already-exists': 'Ese correo ya está registrado',
  'auth/phone-number-already-exists': 'El teléfono ya está en uso',
  'auth/invalid-email': 'El formato del correo no es válido',
  'auth/invalid-phone-number':
    'El formato del teléfono no es válido: usá el formato E.164, por ejemplo +5493764000000',
};

/**
 * PUERTO de autenticación de Firebase (Admin SDK). Los services de dominio
 * (auth, users, customer, delivery) hablan con ESTA interfaz, no con
 * `firebase-admin` directo: "verificá este token" / "creá este usuario" se
 * expresan acá, y `FirebaseAuthAdapter` (infrastructure) implementa el cómo
 * contra el SDK.
 *
 * Se declara como clase abstracta porque en NestJS es el token de inyección
 * idiomático para puertos (las interfaces no existen en runtime). Ver
 * FirebaseAuthAdapter (infrastructure) para la implementación concreta.
 *
 * `createUserSafe`/`deleteUserSafe` son métodos CONCRETOS (no abstractos):
 * consolidan acá el mapeo de errores y la compensación, y se apoyan en
 * `createUser`/`deleteUser` (los abstractos), así que valen para cualquier
 * adapter.
 */
export abstract class FirebaseAuthPort {
  /** Verifica y decodifica un ID token de Firebase. Usado por el AuthGuard en CADA request autenticado. */
  abstract verifyIdToken(token: string): Promise<auth.DecodedIdToken>;

  /** Crea un usuario en Firebase Auth (email/password). */
  abstract createUser(props: auth.CreateRequest): Promise<auth.UserRecord>;

  /** Busca un usuario de Firebase por email. Lanza si no existe (mismo contrato que el SDK). */
  abstract getUserByEmail(email: string): Promise<auth.UserRecord>;

  /** Borra un usuario de Firebase Auth por uid. */
  abstract deleteUser(uid: string): Promise<void>;

  /** Actualiza propiedades de un usuario de Firebase Auth (ej. email). */
  abstract updateUser(
    uid: string,
    props: auth.UpdateRequest,
  ): Promise<auth.UserRecord>;

  /**
   * Invalida los refresh tokens del usuario: no puede renovar su sesión. El ID
   * token ya emitido vive hasta su vencimiento (≤ 1 h); el bloqueo inmediato lo
   * da el AuthGuard con la base.
   */
  abstract revokeRefreshTokens(uid: string): Promise<void>;

  /** Genera un link de reseteo de contraseña (out-of-band, Firebase lo firma). */
  abstract generatePasswordResetLink(
    email: string,
    actionCodeSettings?: auth.ActionCodeSettings,
  ): Promise<string>;

  /**
   * Crea un usuario de Firebase Auth mapeando los errores comunes del SDK a
   * mensajes claros (mismo mapeo que antes duplicaban Users/Customers/
   * DeliveryService). Lanza `BadRequestException` con el mensaje mapeado —
   * el registro (User+Customer/Delivery) que llama a esto debe rollbackear su
   * propia transacción en el catch, igual que antes.
   */
  async createUserSafe(
    props: CreateFirebaseUserProps,
  ): Promise<auth.UserRecord> {
    try {
      return await this.createUser({
        email: props.email,
        password: props.password,
        displayName: props.full_name,
        phoneNumber: props.phone_number,
      });
    } catch (error) {
      const code = errorCode(error);

      const errorMessage =
        MENSAJES_DE_ALTA_EN_FIREBASE[code ?? ''] ??
        'No se pudo crear la cuenta';
      if (!(code && code in MENSAJES_DE_ALTA_EN_FIREBASE)) {
        logger.error(`Alta en Firebase rechazada: ${mensajeDe(error)}`);
      }

      throw new BadRequestException(errorMessage);
    }
  }

  /**
   * Revoca los refresh tokens de una cuenta, sin lanzar: si Firebase falla se
   * registra y la operación que lo pidió (bloqueo, baja, cambio de clave) sigue,
   * porque el acceso ya lo corta el AuthGuard con la base.
   */
  async revokeRefreshTokensSafe(uid: string, logger: Logger): Promise<void> {
    try {
      await this.revokeRefreshTokens(uid);
    } catch (error) {
      logger.error(
        `No se pudieron revocar las sesiones de la cuenta Firebase ${uid}: ${mensajeDe(error)}`,
      );
    }
  }

  /**
   * Borra una cuenta de Firebase por su `uid`, sin lanzar: lo peor que queda
   * es un usuario huérfano en Firebase. Lo usan la compensación del alta, con
   * el uid que devolvió su propio `createUser`, y la baja de un usuario, con
   * su `firebase_uid`. No existe el borrado por correo: se llevaba puesta la
   * cuenta de quien ya estaba registrado (H-70).
   */
  async deleteUserSafe(uid: string, logger: Logger): Promise<void> {
    try {
      await this.deleteUser(uid);
    } catch (error) {
      logger.warn(
        `No se pudo limpiar el usuario Firebase ${uid}: ${mensajeDe(error)}`,
      );
    }
  }
}
