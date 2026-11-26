import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { app, messaging } from 'firebase-admin';
import { FIREBASE_ADMIN_APP } from '../firebase.constants';
import {
  AvisoContexto,
  NotificationChannel,
  NotificationStatus,
} from '../../notification-log/domain/aviso';
import { NotificationLogRecorder } from '../../notification-log/notification-log.recorder';
import { FcmPort } from '../ports/fcm.port';

/**
 * Adapter del FcmPort sobre el Admin SDK. A diferencia del código viejo
 * (que mandaba con `firebase.messaging()`, la app DEFAULT), este adapter
 * manda SIEMPRE con la app admin única del `FirebaseModule` — arregla el bug
 * de la app "notification-service" que se inicializaba pero nunca se usaba.
 */
@Injectable()
export class FcmAdapter extends FcmPort {
  private readonly logger = new Logger(FcmAdapter.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject(FIREBASE_ADMIN_APP) private readonly adminApp: app.App,
    config: ConfigService,
    private readonly registro: NotificationLogRecorder,
  ) {
    super();
    const configurado = Number(config.get<string>('FCM_TIMEOUT_MS'));
    this.timeoutMs = configurado > 0 ? configurado : 5000;
  }

  async sendToToken(
    token: string,
    message: Omit<messaging.Message, 'token'>,
    contexto?: AvisoContexto,
  ): Promise<string> {
    return this.registro.conRegistro(
      {
        channel: NotificationChannel.PUSH,
        destino: token,
        titulo: message.notification?.title,
        contexto,
      },
      () => this.enviar(token, message),
      (messageId) =>
        messageId
          ? null
          : {
              status: NotificationStatus.FAILED,
              error: 'FCM no confirmó el envío a tiempo',
            },
    );
  }

  private async enviar(
    token: string,
    message: Omit<messaging.Message, 'token'>,
  ): Promise<string> {
    // Si FCM no responde a tiempo no se espera más: el push es best-effort y
    // no puede frenar el flujo que lo dispara. Devuelve '' (sin messageId).
    let timer: NodeJS.Timeout | undefined;
    const vencido = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(`FCM no respondió en ${this.timeoutMs} ms: se sigue`);
        resolve('');
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        this.adminApp.messaging().send({ ...message, token }),
        vencido,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
