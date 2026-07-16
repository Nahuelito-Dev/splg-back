import { Inject, Injectable } from '@nestjs/common';
import { app, messaging } from 'firebase-admin';
import { FIREBASE_ADMIN_APP } from '../firebase.constants';
import { FcmPort } from '../ports/fcm.port';

/**
 * Adapter del FcmPort sobre el Admin SDK. A diferencia del código viejo
 * (que mandaba con `firebase.messaging()`, la app DEFAULT), este adapter
 * manda SIEMPRE con la app admin única del `FirebaseModule` — arregla el bug
 * de la app "notification-service" que se inicializaba pero nunca se usaba.
 */
@Injectable()
export class FcmAdapter extends FcmPort {
  constructor(@Inject(FIREBASE_ADMIN_APP) private readonly adminApp: app.App) {
    super();
  }

  async sendToToken(
    token: string,
    message: Omit<messaging.Message, 'token'>,
  ): Promise<string> {
    return this.adminApp.messaging().send({ ...message, token });
  }
}
