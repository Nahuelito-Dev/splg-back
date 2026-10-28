import { htmlDelAviso, rutaDelPanelDelAviso } from './aviso-por-correo';
import { AdminNotification } from './entities/admin-notification.entity';

function aviso(parcial: Partial<AdminNotification>): AdminNotification {
  return {
    title: 'T',
    body: 'B',
    linkEntity: null,
    linkId: null,
    ...parcial,
  } as AdminNotification;
}

describe('aviso por correo', () => {
  it('F11: lleva a la tarea de flota y al legajo', () => {
    expect(
      rutaDelPanelDelAviso(aviso({ linkEntity: 'fleet-task', linkId: 't1' })),
    ).toBe('fleet/tasks/t1');
    expect(
      rutaDelPanelDelAviso(aviso({ linkEntity: 'employee', linkId: 'e1' })),
    ).toBe('employees/details/e1?tab=documents');
  });

  it('lleva al pedido, al reclamo y a la incidencia; una entidad desconocida, a la portada', () => {
    expect(
      rutaDelPanelDelAviso(aviso({ linkEntity: 'order', linkId: 'o 1' })),
    ).toBe('orders/o%201');
    expect(
      rutaDelPanelDelAviso(aviso({ linkEntity: 'claim', linkId: 'c' })),
    ).toBe('claims');
    expect(
      rutaDelPanelDelAviso(aviso({ linkEntity: 'incident', linkId: 'i' })),
    ).toBe('incidents');
    expect(
      rutaDelPanelDelAviso(aviso({ linkEntity: 'car', linkId: 'x' })),
    ).toBe('');
  });

  it('sin destino no hay ruta', () => {
    expect(rutaDelPanelDelAviso(aviso({}))).toBeNull();
  });

  it('escapa también la URL y respeta los saltos de línea del cuerpo', () => {
    const html = htmlDelAviso(
      aviso({ title: 'a&b', body: 'uno\ndos' }),
      'https://panel.test/x?a=1&b="2"',
    );

    expect(html).toContain('<h2>a&amp;b</h2>');
    expect(html).toContain('uno<br>dos');
    expect(html).toContain(
      'href="https://panel.test/x?a=1&amp;b=&quot;2&quot;"',
    );
  });
});
