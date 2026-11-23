import { DiaHistorial } from './disponibilidad';
import { ModeloPagina } from './pagina-estado.modelo';
import { cspDePagina, escapar, renderPaginaEstado } from './pagina-estado.html';

function dias(
  n: number,
  estado: DiaHistorial['estado'] = 'ok',
): DiaHistorial[] {
  return Array.from({ length: n }, (_, i) => ({
    fecha: `2026-11-${String(i + 1).padStart(2, '0')}`,
    estado,
    disponibilidad: estado === 'sin-datos' ? null : 100,
    minutosCaidos: 0,
  }));
}

function base(): ModeloPagina {
  const d = dias(22);
  return {
    general: 'ok',
    verificadoEn: Date.parse('2026-11-22T18:05:00Z'),
    version: '1.0.0',
    historialDisponible: true,
    componentes: [
      {
        id: 'api',
        nombre: 'API',
        detalle: 'Pedidos',
        actual: 'up',
        historial: { dias: d, disponibilidad: 100, incidentes: [] },
      },
      {
        id: 'postgres',
        nombre: 'Base de datos',
        detalle: 'PostgreSQL',
        actual: 'down',
        historial: {
          dias: d.map((x, i) =>
            i === 21
              ? {
                  ...x,
                  estado: 'parcial',
                  disponibilidad: 98.61,
                  minutosCaidos: 20,
                }
              : x,
          ),
          disponibilidad: 99.9,
          incidentes: [
            {
              fecha: '2026-11-22',
              desde: '10:00',
              hasta: '10:20',
              tipo: 'caido',
              minutos: 20,
            },
            {
              fecha: '2026-11-05',
              desde: '00:00',
              hasta: '01:00',
              tipo: 'sin-datos-servidor',
              minutos: 60,
            },
          ],
        },
      },
    ],
  };
}

describe('renderPaginaEstado', () => {
  it('muestra encabezado, franja general, componentes, pie y link al JSON', () => {
    const html = renderPaginaEstado(base(), 'abc');
    expect(html).toContain('<span class="marca">SPLG</span>');
    expect(html).toContain('Estado de la API');
    expect(html).toContain('Todo funcionando');
    expect(html).toContain('Base de datos');
    expect(html).toContain('Operativo');
    expect(html).toContain('Caído');
    expect(html).toContain('Versión de la API: 1.0.0');
    expect(html).toContain('22/11/2026 15:05');
    expect(html).toContain('href="?format=json"');
  });

  it('una barra por día con tooltip de fecha, porcentaje y minutos caídos', () => {
    const html = renderPaginaEstado(base(), 'abc');
    expect(html).toContain('data-tip="22 nov 2026 · 98,61 % · 20 min caído"');
    expect(html).toContain('data-tip="1 nov 2026 · 100,00 % · sin caídas"');
    expect((html.match(/class="dia /g) ?? []).length).toBe(44);
  });

  it('días sin datos salen como "Sin datos"', () => {
    const m = base();
    m.componentes[0].historial.dias = dias(3, 'sin-datos');
    expect(renderPaginaEstado(m, 'n')).toContain('· Sin datos"');
  });

  it('lista incidentes por día y "Sin incidentes" en los días limpios', () => {
    const html = renderPaginaEstado(base(), 'abc');
    expect(html).toContain('22 de noviembre de 2026');
    expect(html).toContain('10:00 a 10:20 h');
    expect(html).toContain('Sin datos: servidor apagado');
    expect(html).toContain('Sin incidentes');
    // el día viejo con incidente aparece aunque esté fuera de los 14 visibles
    expect(html).toContain('5 de noviembre de 2026');
  });

  it('los textos de estado no dependen sólo del color', () => {
    const html = renderPaginaEstado(base(), 'abc');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="img" aria-label="Últimos 90 días');
    expect(html).toContain('Caída importante');
  });

  it('banner parcial y caída', () => {
    const m = base();
    m.general = 'parcial';
    expect(renderPaginaEstado(m, 'n')).toContain('Funcionamiento parcial');
    m.general = 'caida';
    expect(renderPaginaEstado(m, 'n')).toContain('>Caída<');
  });

  it('sin historial (Redis caído) lo avisa y no se rompe', () => {
    const m = base();
    m.historialDisponible = false;
    const html = renderPaginaEstado(m, 'n');
    expect(html).toContain('Historial no disponible');
    expect(html).toContain('historial de incidentes no está disponible');
  });

  it('es autocontenida: sin recursos externos ni atributos style', () => {
    const html = renderPaginaEstado(base(), 'abc');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link|<img|src=/);
    expect(html).not.toMatch(/ style="/);
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('name="viewport"');
  });

  it('escapa el HTML de todo lo que se interpola: versión, nombres, detalles, tooltips e incidentes', () => {
    const veneno = '<img src=x onerror=alert(1)>"\'';
    const m = base();
    m.version = veneno;
    m.componentes[0].nombre = veneno;
    m.componentes[0].detalle = veneno;
    m.componentes[1].nombre = veneno;
    m.componentes[1].detalle = veneno;
    m.componentes[1].historial.dias[0].fecha = veneno;
    m.componentes[1].historial.incidentes = [
      {
        fecha: veneno,
        desde: veneno,
        hasta: veneno,
        tipo: 'caido',
        minutos: 5,
      },
      {
        fecha: '2026-11-22',
        desde: veneno,
        hasta: veneno,
        tipo: 'sin-datos-servidor',
        minutos: 5,
      },
    ];
    const html = renderPaginaEstado(m, 'n');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=alert(1)>');
    expect(html).not.toMatch(/data-tip="[^"]*[<>]/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');
    expect(escapar(`"&'<>`)).toBe('&quot;&amp;&#39;&lt;&gt;');
  });

  it('la CSP sólo habilita el nonce de la respuesta', () => {
    expect(cspDePagina('XYZ')).toBe(
      "default-src 'none'; style-src 'nonce-XYZ'; script-src 'nonce-XYZ'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
});
