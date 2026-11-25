import { messaging } from 'firebase-admin';
import { AvisoContexto } from '../../notification-log/domain/aviso';

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
  /**
   * Manda un push a un device token puntual. Devuelve el messageId del SDK.
   * Cada envío queda en el registro de avisos: `contexto` completa lo que el
   * mensaje no dice (tipo, pedido, destinatario, distribuidora). Nada se
   * deduce de `message.data`: lo que no se pasa queda sin dato.
   */
  abstract sendToToken(
    token: string,
    message: Omit<messaging.Message, 'token'>,
    contexto?: AvisoContexto,
  ): Promise<string>;
}
