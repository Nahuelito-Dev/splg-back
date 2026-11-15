import { marcaDeDistribuidora } from '../email/layout/marca-de-correo';
import { correoDelAviso, rutaDelPanelDelAviso } from './aviso-por-correo';
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

  it('M5: el aviso del envase sin devolver lleva al legajo del caso de recupero', () => {
    expect(
      rutaDelPanelDelAviso(
        aviso({ linkEntity: 'cylinder-recovery-case', linkId: 'c 1' }),
      ),
    ).toBe('physical-cylinders/recovery?case=c%201');
  });

  it('F14: el aviso del seguro lleva a la pestaña de seguro del vehículo', () => {
    expect(
      rutaDelPanelDelAviso(
        aviso({ linkEntity: 'car-insurance', linkId: 'c 1' }),
      ),
    ).toBe('cars/details/c%201?tab=insurance');
  });

  it('F15: el aviso de la multa abre esa multa en el panel', () => {
    expect(
      rutaDelPanelDelAviso(
        aviso({ linkEntity: 'traffic-fine', linkId: 'm 1' }),
      ),
    ).toBe('fleet/fines?fine=m%201');
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
    const { html } = correoDelAviso(
      aviso({ title: 'a&b', body: 'uno\ndos' }),
      'https://panel.test/x?a=1&b="2"',
      marcaDeDistribuidora('Gas del Sur', {}),
    );

    expect(html).toContain('>a&amp;b</h1>');
    expect(html).toContain('uno<br>dos');
    expect(html).toContain(
      'href="https://panel.test/x?a=1&amp;b=&quot;2&quot;"',
    );
  });

  it('asunto en una línea, preheader del cuerpo y texto plano con el enlace', () => {
    const correo = correoDelAviso(
      aviso({ title: 'Vence\r\nla VTV', body: 'x'.repeat(200) }),
      'https://panel.test/fleet',
      marcaDeDistribuidora('Gas del Sur', {}),
    );

    expect(correo.asunto).toBe('Vence la VTV');
    expect(correo.html).toContain(`${'x'.repeat(139)}…`);
    expect(correo.text).toContain('Ver en el panel: https://panel.test/fleet');
    expect(correo.text).toContain('Gas del Sur');
  });
});
