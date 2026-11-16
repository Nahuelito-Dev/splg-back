import { Inject, Injectable } from '@nestjs/common';
import { app, auth } from 'firebase-admin';
import { FIREBASE_ADMIN_APP } from '../firebase.constants';
import { FirebaseAuthPort } from '../ports/firebase-auth.port';

/**
 * Adapter del FirebaseAuthPort sobre el Admin SDK, usando la ÚNICA app admin
 * inicializada por `FirebaseModule` (inyectada por token, no reinicializada
 * acá). Único lugar del dominio que conoce `firebase-admin` para auth.
 */
@Injectable()
export class FirebaseAuthAdapter extends FirebaseAuthPort {
  constructor(@Inject(FIREBASE_ADMIN_APP) private readonly adminApp: app.App) {
    super();
  }

  verifyIdToken(token: string): Promise<auth.DecodedIdToken> {
    return this.adminApp.auth().verifyIdToken(token);
  }

  createUser(props: auth.CreateRequest): Promise<auth.UserRecord> {
    return this.adminApp.auth().createUser(props);
  }

  getUserByEmail(email: string): Promise<auth.UserRecord> {
    return this.adminApp.auth().getUserByEmail(email);
  }

  deleteUser(uid: string): Promise<void> {
    return this.adminApp.auth().deleteUser(uid);
  }

  updateUser(uid: string, props: auth.UpdateRequest): Promise<auth.UserRecord> {
    return this.adminApp.auth().updateUser(uid, props);
  }

  generatePasswordResetLink(
    email: string,
    actionCodeSettings?: auth.ActionCodeSettings,
  ): Promise<string> {
    return this.adminApp
      .auth()
      .generatePasswordResetLink(email, actionCodeSettings);
  }
}
