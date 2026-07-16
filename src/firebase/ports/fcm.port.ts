import { messaging } from 'firebase-admin';

/**
 * PUERTO de push notifications (Firebase Cloud Messaging). `NotificationsService`
 * habla con ESTA interfaz, no con `firebase.messaging()` directo. `FcmAdapter`
 * (infrastructure) implementa el envío contra la app admin correcta.
 *
 * Antes de este puerto, `NotificationsService` inicializaba una app nombrada
 * ('notification-service') pero mandaba con `firebase.messaging()` (la app
 * DEFAULT) — esa init no servía para nada. El adapter usa SIEMPRE la app
 * admin única del `FirebaseModule`.
 */
export abstract class FcmPort {
  /** Manda un push a un device token puntual. Devuelve el messageId del SDK. */
  abstract sendToToken(
    token: string,
    message: Omit<messaging.Message, 'token'>,
  ): Promise<string>;
}
