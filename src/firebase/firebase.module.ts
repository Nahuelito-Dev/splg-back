// src/firebase/firebase.module.ts
import { Global, Module } from '@nestjs/common';
import * as firebase from 'firebase-admin';
import { serviceAccount } from '../auth/service-account';
import { FIREBASE_ADMIN_APP } from './firebase.constants';
import { FirebaseAuthPort } from './ports/firebase-auth.port';
import { FcmPort } from './ports/fcm.port';
import { FirebaseAuthAdapter } from './infrastructure/firebase-auth.adapter';
import { FcmAdapter } from './infrastructure/fcm.adapter';

/**
 * Módulo GLOBAL de Firebase Admin: un único punto de inicialización del SDK
 * para todo el proceso (antes había 4 `firebase.initializeApp(...)` sueltos,
 * uno por service: auth, users, notifications, email — con nombres de app
 * distintos y, en notifications, una app inicializada que nunca se usaba
 * porque se mandaba con `firebase.messaging()` default → bug).
 *
 * El resto del código NUNCA debe llamar a `firebase.initializeApp` para el
 * Admin SDK fuera de este módulo. Expone dos puertos de dominio
 * (`FirebaseAuthPort`, `FcmPort`) para que los services dejen de conocer el
 * SDK concreto y sean testeables sin `jest.mock('firebase-admin')` global.
 *
 * NOTA: el client SDK (`firebase/app` + `firebase/auth`) que usa
 * `AuthService.login` para password-auth es OTRA cosa (namespace de paquete
 * distinto, registro de apps separado) y no se toca acá.
 */
@Global()
@Module({
  providers: [
    {
      provide: FIREBASE_ADMIN_APP,
      useFactory: (): firebase.app.App => {
        // Idempotente: si ya existe la app default (ej. en tests que instancian
        // el módulo más de una vez), la reusamos en vez de re-inicializar y
        // volar con "Firebase app named '[DEFAULT]' already exists".
        const existing = firebase.apps.find((a) => a?.name === '[DEFAULT]');
        if (existing) {
          return existing;
        }

        return firebase.initializeApp({
          credential: firebase.credential.cert(serviceAccount),
        });
      },
    },
    { provide: FirebaseAuthPort, useClass: FirebaseAuthAdapter },
    { provide: FcmPort, useClass: FcmAdapter },
  ],
  exports: [FIREBASE_ADMIN_APP, FirebaseAuthPort, FcmPort],
})
export class FirebaseModule {}
