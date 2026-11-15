/**
 * Vista previa de los correos (no manda nada).
 *
 *   npm run email:preview
 *
 * Genera un HTML (y su texto plano) por cada correo del sistema, con datos de
 * ejemplo, en `tmp/email-preview/`, más un `index.html` que los lista. Toma la
 * marca de la plataforma de `PLATFORM_*` y los enlaces de `APP_URL` del `.env`
 * si están.
 */
import 'dotenv/config';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { escaparHtml } from '../src/common/utils/html.util';
import { redirigirCorreo } from '../src/email/redireccion-de-desarrollo';
import {
  catalogoDeComponentes,
  muestrasDeCorreo,
} from '../src/email/vista-previa/muestras-de-correo';

const carpeta = resolve(__dirname, '..', 'tmp', 'email-preview');
rmSync(carpeta, { recursive: true, force: true });
mkdirSync(carpeta, { recursive: true });

interface Entrada {
  archivo: string;
  nombre: string;
  grupo: string;
  asunto: string;
  para: string;
}

const entradas: Entrada[] = [];
const guardar = (
  archivo: string,
  datos: Omit<Entrada, 'archivo'>,
  html: string,
  texto: string,
) => {
  writeFileSync(join(carpeta, `${archivo}.html`), html);
  writeFileSync(join(carpeta, `${archivo}.txt`), texto);
  entradas.push({ archivo, ...datos });
};

for (const m of muestrasDeCorreo({ env: process.env })) {
  guardar(
    m.clave,
    { nombre: m.nombre, grupo: m.grupo, asunto: m.correo.asunto, para: m.para },
    m.correo.html,
    m.correo.text,
  );
}

// Cómo llega uno redirigido con EMAIL_REDIRECT_TO.
const [primera] = muestrasDeCorreo({ env: process.env });
const redirigido = redirigirCorreo(
  {
    to: primera.para,
    subject: primera.correo.asunto,
    html: primera.correo.html,
    text: primera.correo.text,
  },
  'vos@ejemplo.com',
);
guardar(
  'redirigido',
  {
    nombre: 'Redirigido en desarrollo (EMAIL_REDIRECT_TO)',
    grupo: 'Desarrollo',
    asunto: redirigido.subject,
    para: redirigido.to,
  },
  redirigido.html,
  redirigido.text ?? '',
);

const catalogo = catalogoDeComponentes(process.env);
guardar(
  'componentes',
  {
    nombre: 'Catálogo de componentes',
    grupo: 'Desarrollo',
    asunto: catalogo.asunto,
    para: '-',
  },
  catalogo.html,
  catalogo.text,
);

const filas = entradas
  .map(
    (x) => `<tr>
  <td><span class="grupo grupo-${escaparHtml(x.grupo.toLowerCase())}">${escaparHtml(x.grupo)}</span></td>
  <td><a href="${escaparHtml(x.archivo)}.html" target="vista">${escaparHtml(x.nombre)}</a></td>
  <td class="asunto">${escaparHtml(x.asunto)}</td>
  <td class="mono">${escaparHtml(x.para)}</td>
  <td><a class="mono" href="${escaparHtml(x.archivo)}.txt" target="vista">.txt</a></td>
</tr>`,
  )
  .join('\n');

writeFileSync(
  join(carpeta, 'index.html'),
  `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Correos — vista previa</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F5F6F8;color:#0B1220;display:grid;grid-template-columns:minmax(680px,52%) 1fr;height:100vh}
  aside{overflow:auto;padding:24px;border-right:1px solid #E7EAEE;background:#fff}
  h1{font-size:18px;margin:0 0 4px} p{color:#667085;font-size:13px;margin:0 0 16px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{padding:8px 6px;border-top:1px solid #F0F2F5;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#667085}
  a{color:#B8430B;text-decoration:none} a:hover{text-decoration:underline}
  .asunto{color:#344054}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#667085}
  .grupo{font-size:11px;padding:2px 8px;border-radius:999px;background:#F0F2F5;color:#344054;white-space:nowrap}
  .grupo-plataforma{background:#FFF7ED;color:#C2410C}.grupo-distribuidora{background:#0B0F16;color:#FFB020}
  iframe{width:100%;height:100%;border:0;background:#fff}
</style></head>
<body><aside><h1>Correos del sistema</h1>
<p>${entradas.length} vistas previas generadas el ${escaparHtml(new Date().toLocaleString('es-AR'))}. Tocá uno para verlo a la derecha.</p>
<table><tr><th>Marca</th><th>Correo</th><th>Asunto</th><th>Para</th><th></th></tr>
${filas}
</table></aside>
<iframe name="vista" src="${escaparHtml(entradas[0].archivo)}.html" title="Vista previa"></iframe>
</body></html>`,
);

console.log(`Vista previa: ${entradas.length} correos en ${carpeta}`);
console.log(`Abrí ${join(carpeta, 'index.html')}`);
