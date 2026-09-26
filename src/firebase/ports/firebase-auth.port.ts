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

      let errorMessage = `Error creating Firebase user: ${mensajeDe(error)}`;

      if (code === 'auth/weak-password') {
        errorMessage = 'Password is too weak. Use at least 6 characters.';
      } else if (code === 'auth/email-already-exists') {
        errorMessage = 'Email already exists in Firebase.';
      } else if (code === 'auth/invalid-email') {
        errorMessage = 'Invalid email format.';
      } else if (code === 'auth/invalid-phone-number') {
        errorMessage =
          'Invalid phone number format. Use E.164 format: +1234567890';
      }

      throw new BadRequestException(errorMessage);
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
