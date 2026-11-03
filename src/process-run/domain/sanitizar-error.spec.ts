import { sanitizarError } from './sanitizar-error';

describe('sanitizarError', () => {
  it('tapa tokens, credenciales y correos', () => {
    const limpio = sanitizarError(
      'falló https://api.x/y?access_token=abc123secret y Bearer eyJhbGciOi.payload.firma con juan@correo.com password: hunter2',
    );
    expect(limpio).not.toMatch(/abc123secret|eyJhbGciOi|juan@correo|hunter2/);
    expect(limpio).toContain('[oculto]');
  });

  it('tapa las claves largas', () => {
    expect(sanitizarError(`clave ${'a'.repeat(40)} inválida`)).toBe(
      'clave [oculto] inválida',
    );
  });

  it('recorta a 500 caracteres', () => {
    expect(sanitizarError('x '.repeat(600)).length).toBeLessThanOrEqual(500);
  });

  it('deja intacto un mensaje común', () => {
    expect(sanitizarError('connect ECONNREFUSED 127.0.0.1:5432')).toBe(
      'connect ECONNREFUSED 127.0.0.1:5432',
    );
  });
});
