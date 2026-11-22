import { EstadoGeneral } from './componentes';
import { DiaHistorial, EstadoDia, Incidente } from './disponibilidad';
import { ComponenteDePagina, ModeloPagina } from './pagina-estado.modelo';

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const OFFSET_ARGENTINA_MS = -3 * 60 * 60_000;
const DIAS_VISIBLES_SIN_INCIDENTES = 14;

const BANNER: Record<
  EstadoGeneral,
  { clase: string; icono: string; texto: string }
> = {
  ok: { clase: 'ok', icono: '✓', texto: 'Todo funcionando' },
  parcial: { clase: 'parcial', icono: '!', texto: 'Funcionamiento parcial' },
  caida: { clase: 'caida', icono: '✕', texto: 'Caída' },
};

const TEXTO_DIA: Record<EstadoDia, string> = {
  ok: 'Sin caídas',
  parcial: 'Con caídas breves',
  caido: 'Caída importante',
  'sin-datos': 'Sin datos',
};

export function escapar(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function porcentaje(valor: number | null): string {
  return valor === null
    ? 'Sin datos'
    : `${valor.toFixed(2).replace('.', ',')} %`;
}

function fechaLarga(fecha: string): string {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  return `${dia} de ${MESES[mes - 1] ?? ''} de ${anio}`;
}

function fechaCorta(fecha: string): string {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  return `${dia} ${(MESES[mes - 1] ?? '').slice(0, 3)} ${anio}`;
}

function horaArgentina(ts: number): string {
  const d = new Date(ts + OFFSET_ARGENTINA_MS).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 16)}`;
}

function minutosTexto(minutos: number): string {
  if (minutos < 60) return `${minutos} min`;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function tooltipDia(dia: DiaHistorial): string {
  if (dia.disponibilidad === null) {
    return `${fechaCorta(dia.fecha)} · Sin datos`;
  }
  const caidos =
    dia.minutosCaidos === 0
      ? 'sin caídas'
      : `${minutosTexto(dia.minutosCaidos)} caído`;
  return `${fechaCorta(dia.fecha)} · ${porcentaje(dia.disponibilidad)} · ${caidos}`;
}

function barras(componente: ComponenteDePagina): string {
  return componente.historial.dias
    .map(
      (d) =>
        `<span class="dia ${d.estado}" data-tip="${escapar(tooltipDia(d))}"></span>`,
    )
    .join('');
}

function filaComponente(c: ComponenteDePagina, modelo: ModeloPagina): string {
  const caido = c.actual === 'down';
  const diasConProblemas = c.historial.dias.filter(
    (d) => d.estado === 'parcial' || d.estado === 'caido',
  ).length;
  const resumen = modelo.historialDisponible
    ? `Últimos 90 días: ${porcentaje(c.historial.disponibilidad)} de disponibilidad, ${diasConProblemas} ${diasConProblemas === 1 ? 'día' : 'días'} con caídas.`
    : 'Historial no disponible por el momento.';
  return `<li class="componente">
  <div class="cabeza">
    <h3>${escapar(c.nombre)} <span class="detalle">${escapar(c.detalle)}</span></h3>
    <span class="estado ${caido ? 'caido' : 'ok'}"><span aria-hidden="true">${caido ? '✕' : '✓'}</span> ${caido ? 'Caído' : 'Operativo'}</span>
  </div>
  <div class="barras" role="img" aria-label="${escapar(resumen)}">${barras(c)}</div>
  <div class="escala"><span>Hace 90 días</span><span class="uptime">${porcentaje(c.historial.disponibilidad)} disponible</span><span>Hoy</span></div>
</li>`;
}

interface IncidenteDeComponente extends Incidente {
  componente: string;
}

function textoIncidente(i: IncidenteDeComponente): string {
  const desc = i.tipo === 'caido' ? 'Caído' : 'Sin datos: servidor apagado';
  return `<li><span class="inc-comp">${escapar(i.componente)}</span> <span class="inc-hora">${escapar(i.desde)} a ${escapar(i.hasta)} h</span> <span class="inc-desc">${desc} (${minutosTexto(i.minutos)})</span></li>`;
}

function historialIncidentes(modelo: ModeloPagina): string {
  if (!modelo.historialDisponible) {
    return '<p class="vacio">El historial de incidentes no está disponible por el momento.</p>';
  }
  const porDia = new Map<string, IncidenteDeComponente[]>();
  for (const c of modelo.componentes) {
    for (const i of c.historial.incidentes) {
      const lista = porDia.get(i.fecha) ?? [];
      lista.push({ ...i, componente: c.nombre });
      porDia.set(i.fecha, lista);
    }
  }
  const fechas = (modelo.componentes[0]?.historial.dias ?? [])
    .map((d) => d.fecha)
    .reverse();
  const visibles = fechas.filter(
    (f, indice) => porDia.has(f) || indice < DIAS_VISIBLES_SIN_INCIDENTES,
  );
  return visibles
    .map((f) => {
      const lista = porDia.get(f);
      const cuerpo = lista
        ? `<ul class="incidentes">${lista
            .sort((a, b) => a.desde.localeCompare(b.desde))
            .map(textoIncidente)
            .join('')}</ul>`
        : '<p class="vacio">Sin incidentes</p>';
      return `<section class="dia-inc"><h3>${escapar(fechaLarga(f))}</h3>${cuerpo}</section>`;
    })
    .join('\n');
}

const ESTILOS = `
:root{color-scheme:light dark;--fondo:#F5F6F8;--superficie:#FFFFFF;--tinta:#0B1220;--tinta2:#475467;--linea:#E7EAEE;--marca:#B8430B;
--ok:#067647;--ok-suave:#ECFDF3;--parcial:#B54708;--parcial-suave:#FFFAEB;--caida:#B42318;--caida-suave:#FEF3F2;--gris:#D0D5DD;--barra-ok:#12935A;--barra-parcial:#F79009;--barra-caido:#D92D20}
@media (prefers-color-scheme:dark){:root{--fondo:#0B0F16;--superficie:#131A25;--tinta:#F3F4F6;--tinta2:#C7CCD4;--linea:#2E3847;--marca:#FF9A52;
--ok:#3DBD82;--ok-suave:#0F2A1E;--parcial:#F2B84B;--parcial-suave:#2E2210;--caida:#F2706A;--caida-suave:#2E1212;--gris:#2E3847;--barra-ok:#3DBD82;--barra-parcial:#F2B84B;--barra-caido:#F2706A}}
*{box-sizing:border-box}
body{margin:0;background:var(--fondo);color:var(--tinta);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.pagina{max-width:760px;margin:0 auto;padding:24px 16px 40px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.marca{font-size:1.5rem;font-weight:800;letter-spacing:.04em;color:var(--marca)}
header h1{margin:0;font-size:1.1rem;font-weight:600;color:var(--tinta2)}
.banner{display:flex;align-items:center;gap:12px;padding:16px 20px;border-radius:12px;font-size:1.15rem;font-weight:700;border:1px solid transparent;margin-bottom:28px}
.banner .icono{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:currentColor;flex:none}
.banner .icono b{color:var(--superficie);font-size:1rem;line-height:1}
.banner.ok{background:var(--ok-suave);color:var(--ok);border-color:var(--ok)}
.banner.parcial{background:var(--parcial-suave);color:var(--parcial);border-color:var(--parcial)}
.banner.caida{background:var(--caida-suave);color:var(--caida);border-color:var(--caida)}
h2{font-size:1.05rem;margin:0 0 12px}
ul{list-style:none;margin:0;padding:0}
.componentes{background:var(--superficie);border:1px solid var(--linea);border-radius:12px;margin-bottom:32px}
.componente{padding:16px 20px;border-top:1px solid var(--linea)}
.componente:first-child{border-top:0}
.cabeza{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.cabeza h3{margin:0;font-size:1rem}
.detalle{font-weight:400;font-size:.85rem;color:var(--tinta2);margin-left:6px}
.estado{font-weight:600;font-size:.9rem}
.estado.ok{color:var(--ok)}.estado.caido{color:var(--caida)}
.barras{display:flex;gap:1px;height:36px;align-items:stretch}
.dia{flex:1 1 0;min-width:0;border-radius:2px;background:var(--gris);cursor:default}
.dia.ok{background:var(--barra-ok)}
.dia.parcial{background:var(--barra-parcial)}
.dia.caido{background:repeating-linear-gradient(135deg,var(--barra-caido) 0 3px,var(--superficie) 3px 4px)}
.dia:hover,.dia.activo{outline:2px solid var(--tinta);outline-offset:1px}
.escala{display:flex;justify-content:space-between;gap:8px;font-size:.8rem;color:var(--tinta2);margin-top:6px}
.escala .uptime{font-weight:600}
.leyenda{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.8rem;color:var(--tinta2);margin:-20px 0 32px}
.leyenda span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;background:var(--gris)}
.leyenda .l-ok::before{background:var(--barra-ok)}.leyenda .l-parcial::before{background:var(--barra-parcial)}
.leyenda .l-caido::before{background:repeating-linear-gradient(135deg,var(--barra-caido) 0 3px,var(--superficie) 3px 4px)}
.dia-inc{padding:14px 0;border-top:1px solid var(--linea)}
.dia-inc h3{margin:0 0 6px;font-size:.95rem}
.vacio{margin:0;color:var(--tinta2);font-size:.9rem}
.incidentes li{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:.9rem;padding:2px 0}
.inc-comp{font-weight:600}.inc-desc{color:var(--caida)}.inc-hora{color:var(--tinta2)}
footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--linea);font-size:.85rem;color:var(--tinta2);display:flex;flex-wrap:wrap;gap:6px 20px}
footer a{color:var(--marca);font-weight:600}
#tip{position:fixed;z-index:10;pointer-events:none;background:var(--tinta);color:var(--superficie);padding:6px 10px;border-radius:6px;font-size:.8rem;max-width:260px;display:none}
a:focus-visible{outline:2px solid var(--marca);outline-offset:2px}
`;

const SCRIPT = `
(function(){
var tip=document.getElementById('tip');var activo=null;
function mostrar(el){if(activo)activo.classList.remove('activo');activo=el;if(!el){tip.style.display='none';return}
el.classList.add('activo');tip.textContent=el.getAttribute('data-tip');tip.style.display='block';
var r=el.getBoundingClientRect();var w=tip.offsetWidth;
var x=Math.min(Math.max(8,r.left+r.width/2-w/2),window.innerWidth-w-8);
tip.style.left=x+'px';tip.style.top=Math.max(8,r.top-tip.offsetHeight-8)+'px'}
document.addEventListener('mouseover',function(e){var t=e.target;mostrar(t.classList&&t.classList.contains('dia')?t:null)});
document.addEventListener('click',function(e){var t=e.target;mostrar(t.classList&&t.classList.contains('dia')?t:null)});
document.addEventListener('scroll',function(){mostrar(null)},{passive:true});
})();
`;

/** Política para la página: todo propio, con un `nonce` para el CSS y el JS en línea. */
export function cspDePagina(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function renderPaginaEstado(
  modelo: ModeloPagina,
  nonce: string,
): string {
  const banner = BANNER[modelo.general];
  const filas = modelo.componentes
    .map((c) => filaComponente(c, modelo))
    .join('\n');
  const leyenda = (Object.keys(TEXTO_DIA) as EstadoDia[])
    .map((e) => {
      const clase =
        e === 'ok'
          ? 'l-ok'
          : e === 'parcial'
            ? 'l-parcial'
            : e === 'caido'
              ? 'l-caido'
              : '';
      return `<span class="${clase}">${TEXTO_DIA[e]}</span>`;
    })
    .join('');
  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>SPLG · Estado de la API</title>
<style nonce="${nonce}">${ESTILOS}</style>
</head>
<body>
<main class="pagina">
<header><span class="marca">SPLG</span><h1>Estado de la API</h1></header>
<div class="banner ${banner.clase}" role="status"><span class="icono" aria-hidden="true"><b>${banner.icono}</b></span><span>${banner.texto}</span></div>
<h2>Componentes</h2>
<ul class="componentes">
${filas}
</ul>
<div class="leyenda" aria-label="Referencias de las barras">${leyenda}</div>
<h2>Historial de incidentes</h2>
<div>
${historialIncidentes(modelo)}
</div>
<footer>
<span>Versión de la API: ${escapar(modelo.version)}</span>
<span>Última verificación: <time datetime="${new Date(modelo.verificadoEn).toISOString()}">${escapar(horaArgentina(modelo.verificadoEn))}</time> (hora de Argentina)</span>
<a href="?format=json">Ver en JSON</a>
</footer>
</main>
<div id="tip" role="tooltip"></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
