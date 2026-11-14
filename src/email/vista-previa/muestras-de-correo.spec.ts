import { catalogoDeComponentes, muestrasDeCorreo } from './muestras-de-correo';

const ENV = {
  PLATFORM_NAME: 'OrixTech',
  PLATFORM_SUPPORT_EMAIL: 'soporte@orixtech.test',
  APP_URL: 'https://app.test',
};

/**
 * Todos los correos del sistema (las plantillas de la plataforma y los avisos
 * de las distribuidoras) pasan por acá con datos de ejemplo: si alguno deja un
 * `undefined`, no escapa un dato o pierde el texto plano, falla.
 */
describe('muestras de correo', () => {
  const muestras = muestrasDeCorreo({ env: ENV });
  const hostiles = muestrasDeCorreo({ env: ENV, hostil: true });

  it('cubre todos los correos, sin claves repetidas', () => {
    const claves = muestras.map((m) => m.clave);
    expect(new Set(claves).size).toBe(claves.length);
    expect(claves).toEqual(
      expect.arrayContaining([
        'welcome',
        'email-verification',
        'password-reset',
        'email-change-notification',
        'aviso-del-panel',
        'jornadas-sin-cerrar',
        'rendiciones-sin-cerrar',
        'carga-anomala',
        'derrame',
        'asignacion-pendiente',
        'vencimientos',
        'propuesta-de-taller',
        'stock-bajo',
        'conciliacion-de-stock',
      ]),
    );
  });

  it.each(muestras.map((m) => [m.clave, m] as const))(
    '%s: asunto, HTML y texto plano sin undefined ni null',
    (_clave, m) => {
      expect(m.correo.asunto.trim()).not.toBe('');
      expect(m.correo.asunto).not.toMatch(/\n/);
      expect(m.correo.text.trim()).not.toBe('');
      for (const salida of [m.correo.asunto, m.correo.html, m.correo.text]) {
        expect(salida).not.toMatch(/undefined|null|NaN|\[object Object\]/);
      }
    },
  );

  it.each(hostiles.map((m) => [m.clave, m] as const))(
    '%s: escapa los datos con HTML (<script>, comillas)',
    (_clave, m) => {
      expect(m.correo.html).not.toContain('<script>');
      expect(m.correo.html).not.toContain('alert("x")');
      expect(m.correo.html).toContain('&lt;script&gt;');
    },
  );

  it('los de la plataforma llevan su marca, sin «con tecnología de»', () => {
    const html = muestras
      .filter((m) => m.grupo === 'Plataforma')
      .map((m) => m.correo.html);
    expect(html.length).toBeGreaterThan(0);
    expect(html.filter((h) => h.includes('Con tecnología de'))).toEqual([]);
    expect(html.every((h) => h.includes('OrixTech'))).toBe(true);
  });

  it('los operativos llevan la distribuidora y «con tecnología de» la plataforma', () => {
    const html = muestras
      .filter((m) => m.grupo === 'Distribuidora')
      .map((m) => m.correo.html);
    expect(html.length).toBeGreaterThan(0);
    expect(
      html.every(
        (h) =>
          h.includes('Gas del Litoral') &&
          h.includes('Con tecnología de') &&
          h.includes('OrixTech'),
      ),
    ).toBe(true);
  });

  it('sin variables de la plataforma igual arma todo (nombre por omisión)', () => {
    expect(muestrasDeCorreo().length).toBe(muestras.length);
  });

  it('el catálogo de componentes arma', () => {
    const c = catalogoDeComponentes();
    expect(c.html).toContain('482 913');
    expect(c.text).toContain('482 913');
  });
});
