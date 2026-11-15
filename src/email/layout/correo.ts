import { escaparHtml } from '../../common/utils/html.util';
import { MarcaDeCorreo } from './marca-de-correo';

/**
 * Layout común de los correos: tablas e inline CSS a 600 px, que es lo que
 * Gmail, Outlook y Apple Mail dibujan igual. Quien arma un correo describe el
 * contenido con bloques (`MensajeDeCorreo`) y `armarCorreo` devuelve el HTML y
 * el texto plano alternativo. Todo texto que entra se escapa acá: nadie
 * concatena HTML a mano.
 */

/** Un pedazo de texto: liso, en negrita, en monoespaciada (ids, patentes) o enlace. */
export type Fragmento =
  | string
  | { fuerte: string }
  | { mono: string }
  | { enlace: string; url: string };

/** Texto de un bloque: un string o una secuencia de fragmentos. */
export type Texto = string | readonly Fragmento[];

export type TonoDeNota = 'info' | 'aviso' | 'peligro' | 'exito';

export interface ColumnaDeTabla {
  titulo: string;
  /** Números y montos a la derecha. */
  alinear?: 'izquierda' | 'derecha';
  /** Ids, patentes y cifras en monoespaciada. */
  mono?: boolean;
}

export type BloqueDeCorreo =
  | { tipo: 'parrafo'; texto: Texto; suave?: boolean }
  | { tipo: 'boton'; texto: string; url: string }
  /** «Si el botón no funciona, copiá este enlace»: el enlace a la vista. */
  | { tipo: 'enlace-alternativo'; url: string }
  | { tipo: 'nota'; tono: TonoDeNota; titulo?: string; texto: Texto }
  /** Datos clave: etiqueta → valor. */
  | {
      tipo: 'datos';
      titulo?: string;
      filas: ReadonlyArray<{ etiqueta: string; valor: Texto; mono?: boolean }>;
    }
  /** Una lista de renglones con columnas (jornadas, rendiciones, depósitos). */
  | {
      tipo: 'tabla';
      titulo?: string;
      columnas: readonly ColumnaDeTabla[];
      filas: ReadonlyArray<readonly string[]>;
    }
  | { tipo: 'lista'; items: readonly Texto[] }
  /** Un código para copiar (verificación). */
  | { tipo: 'codigo'; codigo: string; etiqueta?: string }
  | { tipo: 'separador' };

export interface MensajeDeCorreo {
  asunto: string;
  /** Lo que la bandeja muestra al lado del asunto (no se ve en el cuerpo). */
  preheader: string;
  /** Etiqueta chica arriba del título («Seguridad de la cuenta», «Aviso de flota»). */
  etiqueta?: string;
  titulo: string;
  bloques: readonly BloqueDeCorreo[];
  /** Por qué le llega este correo a quien lo lee (pie). Si falta, uno según la marca. */
  motivo?: string;
}

export interface CorreoArmado {
  asunto: string;
  html: string;
  /** Versión en texto plano, para los clientes que no muestran HTML. */
  text: string;
}

const FUENTE =
  "'Geist','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO =
  "'Geist Mono','SFMono-Regular',ui-monospace,Menlo,Consolas,'Liberation Mono',monospace";

/** Tinta, bordes y estados de Brasa: los comparten las dos marcas. */
const T = {
  tinta: '#0B1220',
  tinta2: '#344054',
  suave: '#667085',
  tenue: '#98A2B3',
  borde: '#E7EAEE',
  bordeSuave: '#F0F2F5',
  caja: '#FAFBFC',
  blanco: '#FFFFFF',
} as const;

const TONOS: Record<
  TonoDeNota,
  { color: string; fondo: string; borde: string }
> = {
  info: { color: '#175CD3', fondo: '#EFF8FF', borde: '#B2DDFF' },
  aviso: { color: '#B54708', fondo: '#FFFAEB', borde: '#FEDF89' },
  peligro: { color: '#B42318', fondo: '#FEF3F2', borde: '#FECDCA' },
  exito: { color: '#067647', fondo: '#ECFDF3', borde: '#ABEFC6' },
};

const ETIQUETA_DE_TONO: Record<TonoDeNota, string> = {
  info: 'Info',
  aviso: 'Atención',
  peligro: 'Importante',
  exito: 'Listo',
};

const e = escaparHtml;

/** Sólo `http(s)` y `mailto`: un `javascript:` no llega a un `href`. */
export function urlSegura(url: string | null | undefined): string | null {
  const limpia = url?.trim();
  if (!limpia) return null;
  return /^(https?:\/\/|mailto:)/i.test(limpia) ? limpia : null;
}

function fragmentos(texto: Texto): readonly Fragmento[] {
  return typeof texto === 'string' ? [texto] : texto;
}

function textoHtml(texto: Texto, acento: string): string {
  return fragmentos(texto)
    .map((f) => {
      if (typeof f === 'string') return e(f).replace(/\n/g, '<br>');
      if ('fuerte' in f)
        return `<strong style="font-weight:600;color:${T.tinta};" class="c-tinta">${e(f.fuerte)}</strong>`;
      if ('mono' in f)
        return `<span style="font-family:${MONO};font-size:0.92em;">${e(f.mono)}</span>`;
      const url = urlSegura(f.url);
      return url
        ? `<a href="${e(url)}" style="color:${acento};text-decoration:underline;" class="c-acento">${e(f.enlace)}</a>`
        : e(f.enlace);
    })
    .join('');
}

function textoPlano(texto: Texto): string {
  return fragmentos(texto)
    .map((f) => {
      if (typeof f === 'string') return f;
      if ('fuerte' in f) return f.fuerte;
      if ('mono' in f) return f.mono;
      return urlSegura(f.url) ? `${f.enlace} (${f.url})` : f.enlace;
    })
    .join('');
}

function degrade([desde, hasta]: [string, string], angulo = 135): string {
  return `background-color:${hasta};background-image:linear-gradient(${angulo}deg,${desde},${hasta});`;
}

// ---------------------------------------------------------------- bloques HTML

function bloqueHtml(b: BloqueDeCorreo, marca: MarcaDeCorreo): string {
  const p = marca.paleta;
  switch (b.tipo) {
    case 'parrafo':
      return b.suave
        ? `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${T.suave};" class="c-suave">${textoHtml(b.texto, p.acento)}</p>`
        : `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${T.tinta2};" class="c-tinta2">${textoHtml(b.texto, p.acento)}</p>`;

    case 'boton': {
      const url = urlSegura(b.url);
      if (!url) return '';
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;border-collapse:separate;" class="boton-tabla">
  <tr><td align="center" bgcolor="${p.boton[1]}" style="border-radius:10px;${degrade(p.boton, 180)}" class="boton-celda">
    <a href="${e(url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FUENTE};font-size:15px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;border:1px solid ${p.botonBorde};${degrade(p.boton, 180)}" class="boton-enlace">${e(b.texto)}&nbsp;&rarr;</a>
  </td></tr>
</table>`;
    }

    case 'enlace-alternativo': {
      const url = urlSegura(b.url);
      if (!url) return '';
      return `<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:${T.suave};" class="c-suave">Si el botón no funciona, copiá y pegá este enlace en el navegador:</p>
<p style="margin:0 0 20px;padding:10px 12px;background-color:${T.caja};border:1px solid ${T.borde};border-radius:8px;font-family:${MONO};font-size:12px;line-height:18px;word-break:break-all;" class="c-caja c-borde"><a href="${e(url)}" style="color:${p.acento};text-decoration:none;" class="c-acento">${e(url)}</a></p>`;
    }

    case 'nota': {
      const t = TONOS[b.tono];
      const titulo = b.titulo
        ? `<p style="margin:0 0 4px;font-size:14px;line-height:20px;font-weight:600;color:${t.color};" class="nota-${b.tono}-titulo">${e(b.titulo)}</p>`
        : '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;border-collapse:separate;">
  <tr><td style="padding:14px 16px;background-color:${t.fondo};border:1px solid ${t.borde};border-left:4px solid ${t.color};border-radius:10px;" class="nota-${b.tono}">
    ${titulo}<p style="margin:0;font-size:14px;line-height:21px;color:${T.tinta2};" class="c-tinta2">${textoHtml(b.texto, p.acento)}</p>
  </td></tr>
</table>`;
    }

    case 'datos': {
      const filas = b.filas
        .map(
          (f, i) => `<tr>
    <td valign="top" width="38%" style="padding:11px 16px;${i > 0 ? `border-top:1px solid ${T.bordeSuave};` : ''}font-size:13px;line-height:20px;color:${T.suave};" class="c-suave c-borde">${e(f.etiqueta)}</td>
    <td valign="top" style="padding:11px 16px;${i > 0 ? `border-top:1px solid ${T.bordeSuave};` : ''}font-size:14px;line-height:20px;font-weight:600;color:${T.tinta};${f.mono ? `font-family:${MONO};font-size:13px;` : ''}word-break:break-word;" class="c-tinta c-borde">${textoHtml(f.valor, p.acento)}</td>
  </tr>`,
        )
        .join('\n');
      return `${tituloDeSeccion(b.titulo)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${T.borde};border-radius:10px;border-collapse:separate;" class="c-borde">
  ${filas}
</table>`;
    }

    case 'tabla': {
      const alinear = (c: ColumnaDeTabla) =>
        c.alinear === 'derecha' ? 'right' : 'left';
      const cabecera = b.columnas
        .map(
          (c, i) =>
            `<th align="${alinear(c)}" style="padding:9px 12px;${i === 0 ? 'border-top-left-radius:10px;' : ''}${i === b.columnas.length - 1 ? 'border-top-right-radius:10px;' : ''}background-color:${T.caja};border-bottom:1px solid ${T.borde};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${T.suave};" class="c-caja c-suave c-borde">${e(c.titulo)}</th>`,
        )
        .join('');
      const filas = b.filas
        .map(
          (fila, i) =>
            `<tr>${b.columnas
              .map((c, j) => {
                const valor = fila[j] ?? '';
                return `<td align="${alinear(c)}" valign="top" style="padding:10px 12px;${i > 0 ? `border-top:1px solid ${T.bordeSuave};` : ''}font-size:13px;line-height:19px;color:${j === 0 ? T.tinta : T.tinta2};${j === 0 ? 'font-weight:600;' : ''}${c.mono ? `font-family:${MONO};font-size:12px;white-space:nowrap;` : ''}" class="${j === 0 ? 'c-tinta' : 'c-tinta2'} c-borde">${e(valor)}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('\n');
      return `${tituloDeSeccion(b.titulo)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${T.borde};border-radius:10px;border-collapse:separate;" class="c-borde tabla">
  <tr>${cabecera}</tr>
  ${filas}
</table>`;
    }

    case 'lista': {
      const items = b.items
        .map(
          (item) => `<tr>
    <td valign="top" width="18" style="padding:0 0 8px;font-size:15px;line-height:22px;color:${p.acento};" class="c-acento">&bull;</td>
    <td valign="top" style="padding:0 0 8px;font-size:15px;line-height:22px;color:${T.tinta2};" class="c-tinta2">${textoHtml(item, p.acento)}</td>
  </tr>`,
        )
        .join('\n');
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
  ${items}
</table>`;
    }

    case 'codigo':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;border-collapse:separate;">
  <tr><td align="center" style="padding:20px 16px;background-color:${T.caja};border:1px dashed #D0D5DD;border-radius:12px;" class="c-caja c-borde">
    ${b.etiqueta ? `<p style="margin:0 0 8px;font-size:12px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;color:${T.suave};" class="c-suave">${e(b.etiqueta)}</p>` : ''}
    <p style="margin:0;font-family:${MONO};font-size:32px;line-height:40px;font-weight:700;letter-spacing:8px;color:${T.tinta};" class="c-tinta">${e(b.codigo)}</p>
  </td></tr>
</table>`;

    case 'separador':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="border-top:1px solid ${T.borde};font-size:0;line-height:0;" class="c-borde">&nbsp;</td></tr></table>`;
  }
}

function tituloDeSeccion(titulo: string | undefined): string {
  return titulo
    ? `<p style="margin:8px 0 10px;font-size:13px;line-height:18px;font-weight:600;color:${T.tinta};" class="c-tinta">${e(titulo)}</p>`
    : '';
}

// ---------------------------------------------------------------- bloques texto

function bloqueTexto(b: BloqueDeCorreo): string {
  switch (b.tipo) {
    case 'parrafo':
      return textoPlano(b.texto);
    case 'boton': {
      const url = urlSegura(b.url);
      return url ? `${b.texto}: ${url}` : '';
    }
    case 'enlace-alternativo':
      return '';
    case 'nota':
      return `[${b.titulo ?? ETIQUETA_DE_TONO[b.tono]}] ${textoPlano(b.texto)}`;
    case 'datos':
      return [
        ...(b.titulo ? [b.titulo] : []),
        ...b.filas.map((f) => `${f.etiqueta}: ${textoPlano(f.valor)}`),
      ].join('\n');
    case 'tabla':
      return [
        ...(b.titulo ? [b.titulo] : []),
        ...b.filas.map(
          (fila) =>
            '- ' +
            b.columnas
              .map((c, j) => `${c.titulo}: ${fila[j] ?? ''}`)
              .join(' · '),
        ),
      ].join('\n');
    case 'lista':
      return b.items.map((item) => `- ${textoPlano(item)}`).join('\n');
    case 'codigo':
      return `${b.etiqueta ?? 'Código'}: ${b.codigo}`;
    case 'separador':
      return '---';
  }
}

// ---------------------------------------------------------------- armado

function motivoPorOmision(marca: MarcaDeCorreo): string {
  return marca.tipo === 'plataforma'
    ? `Recibís este correo por una acción en tu cuenta de ${marca.nombre}.`
    : `Recibís este aviso porque administrás ${marca.nombre} en el panel.`;
}

/** Relleno del preheader: evita que la bandeja muestre el comienzo del cuerpo a continuación. */
const RELLENO_DE_PREHEADER = '&#847;&zwnj;&nbsp;'.repeat(60);

const ESTILOS = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  a { text-decoration: none; }
  table { border-collapse: collapse; }
  @media only screen and (max-width: 620px) {
    .contenedor { width:100% !important; }
    .afuera { padding:16px 10px !important; }
    .cuerpo { padding:28px 22px 8px !important; }
    .cabecera { padding:20px 22px !important; }
    .titulo { font-size:22px !important; line-height:30px !important; }
    .boton-tabla { width:100% !important; }
    .boton-enlace { display:block !important; }
    .tabla th, .tabla td { padding-left:8px !important; padding-right:8px !important; font-size:12px !important; }
    .tabla th { letter-spacing:0 !important; }
  }
  @media (prefers-color-scheme: dark) {
    .c-fondo { background-color:#0B0F16 !important; }
    .c-tarjeta { background-color:#131A25 !important; border-color:#2E3847 !important; }
    .c-cabecera-clara { background-color:#131A25 !important; border-color:#2E3847 !important; }
    .c-cabecera-clara .c-marca { color:#F3F4F6 !important; }
    .c-tinta { color:#F3F4F6 !important; }
    .c-tinta2 { color:#C7CCD4 !important; }
    .c-suave { color:#8B93A3 !important; }
    .c-borde { border-color:#2E3847 !important; }
    .c-caja { background-color:#171E29 !important; }
    .c-acento { color:#FF9A52 !important; }
    .nota-info { background-color:#11233B !important; border-color:#1D3A5E !important; }
    .nota-aviso { background-color:#2E2210 !important; border-color:#4A3615 !important; }
    .nota-peligro { background-color:#2E1212 !important; border-color:#4D1D1D !important; }
    .nota-exito { background-color:#0F2A1E !important; border-color:#1A4532 !important; }
  }
  [data-ogsc] .c-tinta { color:#F3F4F6 !important; }
  [data-ogsc] .c-tinta2 { color:#C7CCD4 !important; }
`;

function cabeceraHtml(marca: MarcaDeCorreo): string {
  const p = marca.paleta;
  const inicial = e(marca.nombre.trim().charAt(0).toUpperCase() || 'O');
  const clara = marca.tipo === 'plataforma';
  const subtitulo =
    marca.tipo === 'plataforma'
      ? ''
      : `<p style="margin:2px 0 0;font-size:12px;line-height:16px;color:${p.encabezadoSuave};">Avisos del panel</p>`;
  return `<tr><td style="font-size:0;line-height:0;height:4px;border-top-left-radius:14px;border-top-right-radius:14px;${degrade(p.brillo, 90)}" bgcolor="${p.brillo[0]}" height="4">&nbsp;</td></tr>
<tr><td class="cabecera${clara ? ' c-cabecera-clara' : ''}" style="padding:22px 40px;background-color:${p.encabezado};${clara ? `border-left:1px solid ${T.borde};border-right:1px solid ${T.borde};border-bottom:1px solid ${T.bordeSuave};` : ''}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="middle" width="36" height="36" align="center" bgcolor="${p.logo[1]}" style="width:36px;height:36px;border-radius:9px;${degrade(p.logo)}font-family:${FUENTE};font-size:18px;line-height:36px;font-weight:700;color:${p.logoTexto};">${inicial}</td>
    <td valign="middle" style="padding-left:12px;">
      <p class="c-marca" style="margin:0;font-family:${FUENTE};font-size:17px;line-height:22px;font-weight:700;letter-spacing:-0.3px;color:${p.encabezadoTexto};">${e(marca.nombre)}</p>
      ${subtitulo}
    </td>
  </tr></table>
</td></tr>`;
}

function pieHtml(marca: MarcaDeCorreo, motivo: string): string {
  const contacto = urlSegura(
    marca.contacto ? `mailto:${marca.contacto}` : null,
  );
  const ayuda =
    marca.contacto && contacto
      ? `<p style="margin:0 0 8px;">¿Necesitás ayuda? Escribinos a <a href="${e(contacto)}" style="color:${T.suave};text-decoration:underline;" class="c-suave">${e(marca.contacto)}</a>.</p>`
      : '';
  const tecnologia =
    marca.tipo === 'distribuidora'
      ? `<p style="margin:14px 0 0;font-size:11px;line-height:16px;color:${T.tenue};">Con tecnología de <strong style="color:${T.suave};font-weight:600;" class="c-suave">${e(marca.plataforma)}</strong> <span style="display:inline-block;width:6px;height:6px;border-radius:3px;vertical-align:middle;${degrade(['#F97316', '#FACC15'])}">&nbsp;</span></p>`
      : '';
  return `<tr><td align="center" style="padding:24px 32px 8px;font-family:${FUENTE};font-size:12px;line-height:18px;color:${T.suave};" class="c-suave">
  ${ayuda}
  <p style="margin:0 0 8px;">${e(motivo)} Es un mensaje automático: no hace falta que lo respondas.</p>
  <p style="margin:0;color:${T.tenue};">&copy; ${new Date().getFullYear()} ${e(marca.razonSocial)}</p>
  ${tecnologia}
</td></tr>`;
}

/** Arma el correo completo (HTML + texto plano) con la marca dada. */
export function armarCorreo(
  marca: MarcaDeCorreo,
  mensaje: MensajeDeCorreo,
): CorreoArmado {
  const p = marca.paleta;
  const motivo = mensaje.motivo ?? motivoPorOmision(marca);
  const etiqueta = mensaje.etiqueta
    ? `<p style="margin:0 0 8px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${p.acento};" class="c-acento">${e(mensaje.etiqueta)}</p>`
    : '';
  const cuerpo = mensaje.bloques.map((b) => bloqueHtml(b, marca)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(mensaje.asunto)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>${ESTILOS}</style>
</head>
<body style="margin:0;padding:0;background-color:${p.fondo};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;" class="c-fondo">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${p.fondo};">${e(mensaje.preheader)}${RELLENO_DE_PREHEADER}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${p.fondo}" style="background-color:${p.fondo};" class="c-fondo">
<tr><td align="center" class="afuera" style="padding:36px 16px;font-family:${FUENTE};">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="contenedor" style="width:600px;max-width:600px;border-collapse:separate;">
${cabeceraHtml(marca)}
<tr><td class="cuerpo c-tarjeta" style="padding:36px 40px 16px;background-color:${T.blanco};border:1px solid ${T.borde};border-top:0;border-bottom-left-radius:14px;border-bottom-right-radius:14px;font-family:${FUENTE};">
${etiqueta}<h1 class="titulo c-tinta" style="margin:0 0 20px;font-family:${FUENTE};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.5px;color:${T.tinta};">${e(mensaje.titulo)}</h1>
${cuerpo}
</td></tr>
${pieHtml(marca, motivo)}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

  const lineas = mensaje.bloques.map(bloqueTexto).filter((l) => l !== '');
  const text = [
    marca.nombre,
    '',
    mensaje.titulo,
    '='.repeat(Math.min(mensaje.titulo.length, 60)),
    '',
    lineas.join('\n\n'),
    '',
    '--',
    ...(marca.contacto ? [`¿Necesitás ayuda? ${marca.contacto}`] : []),
    `${motivo} Es un mensaje automático: no hace falta que lo respondas.`,
    `© ${new Date().getFullYear()} ${marca.razonSocial}`,
    ...(marca.tipo === 'distribuidora'
      ? [`Con tecnología de ${marca.plataforma}`]
      : []),
  ].join('\n');

  // Una sola línea: un salto en el asunto no se cuela como cabecera.
  return { asunto: mensaje.asunto.replace(/\s+/g, ' ').trim(), html, text };
}
