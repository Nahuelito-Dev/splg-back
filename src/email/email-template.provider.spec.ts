import { EmailTemplateProvider } from './email-template.provider';
import { EnlacesDeLaApp } from './enlaces-de-la-app';
import { marcaDePlataforma } from './layout/marca-de-correo';

const enlaces = {
  inicio: 'https://app.test/',
  accionDeCuenta: 'https://app.test/__/auth/action',
} as EnlacesDeLaApp;
const marca = marcaDePlataforma({
  PLATFORM_NAME: 'OrixTech',
  PLATFORM_SUPPORT_EMAIL: 'soporte@orixtech.test',
});

describe('EmailTemplateProvider', () => {
  const provider = new EmailTemplateProvider(enlaces);

  it('render conserva el contrato: HTML de la plantilla', () => {
    const html = provider.render('welcome', { displayName: 'Ana' });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('Ana');
  });

  it('una plantilla inexistente devuelve el placeholder de siempre', () => {
    expect(provider.render('no-existe', {})).toBe(
      '<p>Plantilla de correo inexistente</p>',
    );
    expect(provider.render('toString', {})).toBe(
      '<p>Plantilla de correo inexistente</p>',
    );
  });

  it('bienvenida: asunto con la marca, saludo, botón a la app y ayuda', () => {
    const c = provider.renderCorreo(
      'welcome',
      { displayName: 'Ana', supportEmail: 'ayuda@x.test' },
      marca,
    );
    expect(c.asunto).toBe('Te damos la bienvenida a OrixTech');
    expect(c.html).toContain('href="https://app.test/"');
    expect(c.html).toContain('mailto:ayuda@x.test');
    expect(c.text).toContain('Ir a la aplicación: https://app.test/');
  });

  it('bienvenida sin nombre ni soporte: «Usuario» y la distribuidora', () => {
    const c = provider.renderCorreo('welcome', {}, marca);
    expect(c.html).toContain('Usuario');
    expect(c.html).toContain('contactá a tu distribuidora');
  });

  it('verificación sin enlace no dibuja un botón roto', () => {
    const c = provider.renderCorreo(
      'email-verification',
      { displayName: 'Ana' },
      marca,
    );
    expect(c.html).not.toContain('Verificar correo');
    expect(c.html).not.toMatch(/undefined|null/);
  });

  it('verificación con enlace: botón y enlace a la vista', () => {
    const c = provider.renderCorreo(
      'email-verification',
      { displayName: 'Ana', verificationLink: 'https://v.test/x' },
      marca,
    );
    expect(c.html).toContain('Verificar correo');
    expect(c.html).toContain('Si el botón no funciona');
    expect(c.text).toContain('Verificar correo: https://v.test/x');
  });

  it('reseteo: cuenta, enlace, vencimiento de 1 hora', () => {
    const c = provider.renderCorreo(
      'password-reset',
      { email: 'ana@x.test', resetLink: 'https://r.test/x' },
      marca,
    );
    expect(c.asunto).toBe('Restablecé tu contraseña de OrixTech');
    expect(c.html).toContain('ana@x.test');
    expect(c.html).toContain('href="https://r.test/x"');
    expect(c.text).toContain('vence en 1 hora');
  });

  it('reseteo sin datos no deja undefined', () => {
    const c = provider.renderCorreo('password-reset', {}, marca);
    expect(c.html).not.toMatch(/undefined|null/);
    expect(c.html).not.toContain('Restablecer contraseña &rarr;');
  });

  it('cambio de correo: dirección nueva, alerta y botón para proteger la cuenta', () => {
    const c = provider.renderCorreo(
      'email-change-notification',
      { displayName: 'Ana', newEmail: 'nueva@x.test' },
      marca,
    );
    expect(c.html).toContain('nueva@x.test');
    expect(c.html).toContain('¿No fuiste vos?');
    expect(c.html).toContain('href="https://app.test/__/auth/action"');
    expect(c.html).toContain('mailto:soporte@orixtech.test');
  });

  it('cambio de correo sin datos ni soporte no deja undefined', () => {
    const c = provider.renderCorreo(
      'email-change-notification',
      {},
      marcaDePlataforma({}),
    );
    expect(c.html).not.toMatch(/undefined|null/);
    expect(c.html).toContain('una dirección nueva');
  });

  it('sin marca explícita usa la de la plataforma', () => {
    expect(provider.renderCorreo('welcome', {}).asunto).toContain(
      marcaDePlataforma().nombre,
    );
  });
});
