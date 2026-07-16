import { auth } from 'firebase-admin';

/**
 * PUERTO de autenticación de Firebase (Admin SDK). Los services de dominio
 * (auth, users, email) hablan con ESTA interfaz, no con `firebase-admin`
 * directo: "verificá este token" / "creá este usuario" se expresan acá, y
 * `FirebaseAuthAdapter` (infrastructure) implementa el cómo contra el SDK.
 *
 * Se declara como clase abstracta porque en NestJS es el token de inyección
 * idiomático para puertos (las interfaces no existen en runtime). Ver
 * FirebaseAuthAdapter (infrastructure) para la implementación concreta.
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
}
