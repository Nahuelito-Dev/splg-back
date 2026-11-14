import { armarCorreo, BloqueDeCorreo, urlSegura } from './correo';
import {
  DISTRIBUIDORA_SIN_NOMBRE,
  marcaDeDistribuidora,
  marcaDePlataforma,
  nombreDeDistribuidoraDeAdmins,
} from './marca-de-correo';

const ENV = {
  PLATFORM_NAME: 'OrixTech',
  PLATFORM_LEGAL_NAME: 'OrixTech SAS',
  PLATFORM_SUPPORT_EMAIL: 'soporte@orixtech.test',
};

const HOSTIL = '<script>alert("x")</script> & \'co\'';

const TODOS_LOS_BLOQUES: BloqueDeCorreo[] = [
  {
    tipo: 'parrafo',
    texto: [
      'a ',
      { fuerte: HOSTIL },
      { mono: HOSTIL },
      { enlace: HOSTIL, url: 'https://x.test/?a=1&b=2' },
    ],
  },
  { tipo: 'parrafo', suave: true, texto: HOSTIL },
  { tipo: 'boton', texto: HOSTIL, url: 'https://x.test/boton' },
  { tipo: 'enlace-alternativo', url: 'https://x.test/alt' },
  { tipo: 'nota', tono: 'peligro', titulo: HOSTIL, texto: HOSTIL },
  { tipo: 'nota', tono: 'info', texto: 'sin título' },
  {
    tipo: 'datos',
    titulo: HOSTIL,
    filas: [
      { etiqueta: HOSTIL, valor: HOSTIL, mono: true },
      { etiqueta: 'Otra', valor: 'x' },
    ],
  },
  {
    tipo: 'tabla',
    titulo: 'Tabla',
    columnas: [
      { titulo: HOSTIL },
      { titulo: 'N', alinear: 'derecha', mono: true },
    ],
    filas: [[HOSTIL, '1'], ['solo una celda']],
  },
  { tipo: 'lista', items: [HOSTIL, ['b ', { fuerte: 'c' }]] },
  { tipo: 'codigo', codigo: '<123>', etiqueta: HOSTIL },
  { tipo: 'codigo', codigo: '999' },
  { tipo: 'separador' },
];

describe('armarCorreo', () => {
  const correo = armarCorreo(marcaDePlataforma(ENV), {
    asunto: `Asunto ${HOSTIL}`,
    preheader: `Pre ${HOSTIL}`,
    etiqueta: HOSTIL,
    titulo: HOSTIL,
    bloques: TODOS_LOS_BLOQUES,
  });

  it('escapa todo dato: ningún <script> ni comilla cruda llega al HTML', () => {
    expect(correo.html).not.toContain('<script>');
    expect(correo.html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;',
    );
    expect(correo.html).toContain('&lt;123&gt;');
    expect(correo.html).toContain('href="https://x.test/?a=1&amp;b=2"');
  });

  it('no deja undefined ni null en el HTML ni en el texto', () => {
    for (const salida of [correo.html, correo.text]) {
      expect(salida).not.toMatch(/undefined|null|\[object Object\]/);
    }
  });

  it('documento de correo: 600 px, preheader oculto, título y modo oscuro', () => {
    expect(correo.html).toMatch(/^<!DOCTYPE html>/);
    expect(correo.html).toContain('<html lang="es"');
    expect(correo.html).toContain('width="600"');
    expect(correo.html).toContain('display:none;max-height:0');
    expect(correo.html).toContain('Pre &lt;script&gt;');
    expect(correo.html).toContain('prefers-color-scheme: dark');
    expect(correo.html).toContain('max-width: 620px');
  });

  it('pie de la plataforma: contacto, aviso legal y razón social; sin «con tecnología de»', () => {
    expect(correo.html).toContain('mailto:soporte@orixtech.test');
    expect(correo.html).toContain('Es un mensaje automático');
    expect(correo.html).toContain('OrixTech SAS');
    expect(correo.html).not.toContain('Con tecnología de');
  });

  it('el texto plano lleva título, botón con URL, datos, tabla, código y pie', () => {
    expect(correo.text).toContain('OrixTech');
    expect(correo.text).toContain(`: https://x.test/boton`);
    expect(correo.text).toContain(`${HOSTIL}: ${HOSTIL}`);
    expect(correo.text).toContain(`- ${HOSTIL}: ${HOSTIL} · N: 1`);
    expect(correo.text).toContain(`- ${HOSTIL}: solo una celda · N: `);
    expect(correo.text).toContain(`${HOSTIL}: <123>`);
    expect(correo.text).toContain('Código: 999');
    expect(correo.text).toContain('[Info] sin título');
    expect(correo.text).toContain('¿Necesitás ayuda? soporte@orixtech.test');
    expect(correo.text).toContain('---');
  });

  it('el asunto sale en una sola línea', () => {
    const { asunto } = armarCorreo(marcaDePlataforma(ENV), {
      asunto: 'Uno\r\nBcc: x@y.com',
      preheader: '',
      titulo: 't',
      bloques: [],
    });
    expect(asunto).toBe('Uno Bcc: x@y.com');
  });

  it('un enlace que no es http(s)/mailto no llega a un href', () => {
    const { html, text } = armarCorreo(marcaDePlataforma(ENV), {
      asunto: 'a',
      preheader: 'p',
      titulo: 't',
      bloques: [
        { tipo: 'boton', texto: 'Mal', url: 'javascript:alert(1)' },
        { tipo: 'enlace-alternativo', url: 'javascript:alert(1)' },
        {
          tipo: 'parrafo',
          texto: [{ enlace: 'texto', url: 'data:text/html,x' }],
        },
      ],
    });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text');
    expect(html).toContain('texto');
    expect(text).not.toContain('javascript:');
  });
});

describe('marca de distribuidora', () => {
  it('lleva el nombre de la distribuidora, Brasa y la plataforma en el pie', () => {
    const correo = armarCorreo(marcaDeDistribuidora('Gas del Sur', ENV), {
      asunto: 'a',
      preheader: 'p',
      titulo: 't',
      bloques: [],
    });
    expect(correo.html).toContain('Gas del Sur');
    expect(correo.html).toContain('#0B0F16');
    expect(correo.html).toContain(
      'Recibís este aviso porque administrás Gas del Sur',
    );
    expect(correo.html).toContain('Con tecnología de');
    expect(correo.text).toContain('Con tecnología de OrixTech');
  });

  it('el motivo del pie se puede cambiar (correo al chofer)', () => {
    const correo = armarCorreo(marcaDeDistribuidora('Gas del Sur', ENV), {
      asunto: 'a',
      preheader: 'p',
      titulo: 't',
      bloques: [],
      motivo: 'Recibís este aviso porque manejás para Gas del Sur.',
    });
    expect(correo.html).toContain('manejás para Gas del Sur');
    expect(correo.html).not.toContain('administrás');
  });

  it('sin nombre usa el genérico', () => {
    expect(marcaDeDistribuidora('  ', ENV).nombre).toBe(
      DISTRIBUIDORA_SIN_NOMBRE,
    );
    expect(marcaDeDistribuidora(null, ENV).nombre).toBe(
      DISTRIBUIDORA_SIN_NOMBRE,
    );
  });

  it('toma el nombre de los administradores que lo traen', () => {
    expect(
      nombreDeDistribuidoraDeAdmins([
        { distributor: null },
        { distributor: { name: ' ' } },
        { distributor: { name: 'Gas del Sur' } },
      ]),
    ).toBe('Gas del Sur');
    expect(nombreDeDistribuidoraDeAdmins([{}])).toBeNull();
  });
});

describe('marca de la plataforma', () => {
  it('sin variables usa el nombre neutro y no inventa contacto', () => {
    const marca = marcaDePlataforma({});
    expect(marca.nombre).toBe('SPLG');
    expect(marca.contacto).toBeNull();
  });
});

describe('urlSegura', () => {
  it('acepta http, https y mailto; rechaza el resto y lo vacío', () => {
    expect(urlSegura(' https://a.test ')).toBe('https://a.test');
    expect(urlSegura('http://a.test')).toBe('http://a.test');
    expect(urlSegura('mailto:a@b.test')).toBe('mailto:a@b.test');
    expect(urlSegura('javascript:x')).toBeNull();
    expect(urlSegura('')).toBeNull();
    expect(urlSegura(undefined)).toBeNull();
  });
});
