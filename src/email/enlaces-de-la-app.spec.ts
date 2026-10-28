import { ConfigService } from '@nestjs/config';
import { EnlacesDeLaApp } from './enlaces-de-la-app';

function enlaces(env: Record<string, string>): EnlacesDeLaApp {
  return new EnlacesDeLaApp({
    get: (k: string) => env[k],
    getOrThrow: (k: string) => env[k],
  } as unknown as ConfigService);
}

describe('EnlacesDeLaApp', () => {
  it('arma las direcciones sobre APP_URL, sin barras de más', () => {
    const e = enlaces({ APP_URL: 'https://panel.splg.test//' });

    expect(e.inicio).toBe('https://panel.splg.test/');
    expect(e.panel('/orders/o-1')).toBe('https://panel.splg.test/orders/o-1');
    expect(e.panel('')).toBe('https://panel.splg.test/');
  });

  it('sin APP_URL usa el dominio del proyecto de Firebase', () => {
    const e = enlaces({ FIREBASE_PROJECT_ID: 'splg' });

    expect(e.panel('claims')).toBe('https://splg.firebaseapp.com/claims');
  });
});
