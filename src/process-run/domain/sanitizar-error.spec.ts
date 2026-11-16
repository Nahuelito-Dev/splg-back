import { sanitizarError } from './sanitizar-error';

describe('sanitizarError', () => {
  it('tapa tokens, credenciales y correos', () => {
    const limpio = sanitizarError(
      'falló https://api.x/y?access_token=abc123secret y Bearer eyJhbGciOi.payload.firma con juan@correo.com password: hunter2',
    );
    expect(limpio).not.toMatch(/abc123secret|eyJhbGciOi|juan@correo|hunter2/);
    expect(limpio).toContain('[oculto]');
  });

  it('tapa claves de Google, conexiones Postgres y teléfonos', () => {
    const limpio = sanitizarError(
      'googleKey=AIzaSyDummY_012345678901234567890123456789 postgres://admin:clave@db.local:5432/splg teléfono=+54 351 555-1234 o 351-555-1234',
    );
    expect(limpio).not.toMatch(
      /AIzaSyDummY|admin:clave|351 555-1234|351-555-1234/,
    );
    expect(limpio).toContain('[oculto]');
  });

  it('tapa Basic, secretos con guiones bajos y conexiones con credenciales', () => {
    const limpio = sanitizarError(
      'Authorization: Basic dXNlcjpjbGF2ZQ== client_secret=s1 refresh_token=s2 access_token=s3 pwd=s4 password=s5 redis://cache:clave@redis.local/0 mongodb://mongo:clave@db.local/app',
    );
    expect(limpio).not.toMatch(/dXNlcjpjbGF2ZQ|s[1-5]|cache:clave|mongo:clave/);
    expect(limpio).toContain('redis://[oculto]@redis.local/0');
    expect(limpio).toContain('mongodb://[oculto]@db.local/app');
  });

  it('no tapa timestamps ni ids numéricos sin formato telefónico', () => {
    expect(sanitizarError('timestamp=1731585600000 pedido=123456789012')).toBe(
      'timestamp=1731585600000 pedido=123456789012',
    );
  });

  it('tapa las claves largas', () => {
    expect(sanitizarError(`clave ${'a'.repeat(40)} inválida`)).toBe(
      'clave [oculto] inválida',
    );
  });

  it('recorta a 300 caracteres después de tapar secretos', () => {
    expect(sanitizarError('x '.repeat(600)).length).toBeLessThanOrEqual(300);
  });

  it('deja intacto un mensaje común', () => {
    expect(sanitizarError('connect ECONNREFUSED 127.0.0.1:5432')).toBe(
      'connect ECONNREFUSED 127.0.0.1:5432',
    );
  });
});
