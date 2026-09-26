import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Las direcciones de la app que viajan en los correos. `APP_URL` las fija; si
 * falta, se usa el dominio del proyecto de Firebase, que Firebase autoriza
 * siempre como destino de sus links de acción.
 */
@Injectable()
export class EnlacesDeLaApp {
  /** Portada de la app, para el botón de bienvenida. */
  readonly inicio: string;
  /** Donde Firebase resuelve los links de reseteo y de verificación. */
  readonly accionDeCuenta: string;

  constructor(config: ConfigService) {
    const base = (
      config.get<string>('APP_URL') ??
      `https://${config.getOrThrow<string>('FIREBASE_PROJECT_ID')}.firebaseapp.com`
    ).replace(/\/+$/, '');
    this.inicio = `${base}/`;
    this.accionDeCuenta = `${base}/__/auth/action`;
  }
}
