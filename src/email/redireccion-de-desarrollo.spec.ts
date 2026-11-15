import {
  destinoDeRedireccion,
  redirigirCorreo,
} from './redireccion-de-desarrollo';

describe('destinoDeRedireccion', () => {
  it('con EMAIL_REDIRECT_TO en desarrollo o test devuelve esa dirección', () => {
    expect(
      destinoDeRedireccion({
        NODE_ENV: 'test',
        EMAIL_REDIRECT_TO: ' nahue@test.com ',
      }),
    ).toBe('nahue@test.com');
    expect(
      destinoDeRedireccion({
        NODE_ENV: 'development',
        EMAIL_REDIRECT_TO: 'nahue@test.com',
      }),
    ).toBe('nahue@test.com');
  });

  it('en producción se ignora siempre', () => {
    expect(
      destinoDeRedireccion({
        NODE_ENV: 'production',
        EMAIL_REDIRECT_TO: 'nahue@test.com',
      }),
    ).toBeNull();
    expect(
      destinoDeRedireccion({
        NODE_ENV: ' Production ',
        EMAIL_REDIRECT_TO: 'nahue@test.com',
      }),
    ).toBeNull();
  });

  it('sin NODE_ENV o con un valor desconocido no redirige (falla cerrada)', () => {
    expect(
      destinoDeRedireccion({ EMAIL_REDIRECT_TO: 'nahue@test.com' }),
    ).toBeNull();
    expect(
      destinoDeRedireccion({
        NODE_ENV: 'staging',
        EMAIL_REDIRECT_TO: 'nahue@test.com',
      }),
    ).toBeNull();
  });

  it('vacía o ausente no redirige', () => {
    expect(
      destinoDeRedireccion({
        NODE_ENV: 'development',
        EMAIL_REDIRECT_TO: '  ',
      }),
    ).toBeNull();
    expect(destinoDeRedireccion({ NODE_ENV: 'development' })).toBeNull();
  });
});

describe('redirigirCorreo', () => {
  const correo = {
    to: 'cliente@<b>.com',
    subject: 'Restablecé tu contraseña',
    html: '<!DOCTYPE html><html><body style="margin:0"><p>Hola</p></body></html>',
    text: 'Hola',
  };

  it('cambia el destinatario y marca el asunto con el original', () => {
    const r = redirigirCorreo(correo, 'nahue@test.com');
    expect(r.to).toBe('nahue@test.com');
    expect(r.subject).toBe('[para: cliente@<b>.com] Restablecé tu contraseña');
  });

  it('pone la banda arriba del cuerpo, escapada, y no toca el resto', () => {
    const { html } = redirigirCorreo(correo, 'nahue@test.com');
    const banda = html.indexOf('Correo de prueba: era para');
    expect(banda).toBeGreaterThan(html.indexOf('<body style="margin:0">'));
    expect(banda).toBeLessThan(html.indexOf('<p>Hola</p>'));
    expect(html).toContain('cliente@&lt;b&gt;.com');
    expect(html).not.toContain('cliente@<b>');
  });

  it('sin <body> la banda va al principio', () => {
    const { html } = redirigirCorreo(
      { to: 'a@b.com', subject: 's', html: '<p>x</p>' },
      'n@t.com',
    );
    expect(html.startsWith('<table')).toBe(true);
    expect(html.endsWith('<p>x</p>')).toBe(true);
  });

  it('el texto plano también avisa; sin texto no lo inventa', () => {
    expect(redirigirCorreo(correo, 'n@t.com').text).toBe(
      'Correo de prueba: era para cliente@<b>.com\n\nHola',
    );
    expect(
      redirigirCorreo({ to: 'a@b.com', subject: 's', html: 'h' }, 'n@t.com'),
    ).not.toHaveProperty('text');
  });
});
