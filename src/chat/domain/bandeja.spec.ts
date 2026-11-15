import {
  ambitoValido,
  assertSePuedeBorrar,
  assertSePuedeConsultarPorElPedido,
  assertSePuedeEditar,
  assertVariablesConocidas,
  canalesQueAtiende,
  completarPlantilla,
  type MensajeABorrar,
  permisoDelCanal,
  respuestaAutomaticaDeLaEmpresa,
  type SituacionDeLaBandeja,
  variablesDe,
} from './bandeja';
import { Channel, MessageKind, SubjectType } from './chat.enums';

const ahora = new Date('2026-11-14T15:00:00Z');
const hace = (min: number) => new Date(ahora.getTime() - min * 60_000);

describe('bandeja: quién atiende qué canal (§5.1)', () => {
  it('cada canal tiene su permiso', () => {
    expect(permisoDelCanal(Channel.STAFF_CUSTOMER)).toBe('mensajes.clientes');
    expect(permisoDelCanal(Channel.STAFF_DRIVER)).toBe('mensajes.choferes');
  });

  it('los canales salen de los permisos: sólo choferes no ve clientes', () => {
    expect(canalesQueAtiende(['mensajes.choferes'])).toEqual([
      Channel.STAFF_DRIVER,
    ]);
    expect(
      canalesQueAtiende(['mensajes.clientes', 'mensajes.choferes']),
    ).toEqual([Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER]);
    expect(canalesQueAtiende(['soporte.ver', 'pedidos.ver'])).toEqual([]);
  });
});

describe('bandeja: conversación por pedido (§4.3)', () => {
  it('en curso, siempre; terminado, hasta 30 días', () => {
    expect(() =>
      assertSePuedeConsultarPorElPedido(
        { status: 'on_the_way', terminadoEn: null },
        ahora,
      ),
    ).not.toThrow();
    expect(() =>
      assertSePuedeConsultarPorElPedido(
        { status: 'delivered', terminadoEn: hace(29 * 24 * 60) },
        ahora,
      ),
    ).not.toThrow();
    expect(() =>
      assertSePuedeConsultarPorElPedido(
        { status: 'cancelled', terminadoEn: hace(31 * 24 * 60) },
        ahora,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'ORDER_CHAT_WINDOW_CLOSED' }) as Error,
    );
  });

  it('el ámbito: general sin pedido, por pedido con pedido', () => {
    expect(ambitoValido(SubjectType.GENERAL, null)).toBe(true);
    expect(ambitoValido(SubjectType.GENERAL, 'p')).toBe(false);
    expect(ambitoValido(SubjectType.ORDER, 'p')).toBe(true);
    expect(ambitoValido(SubjectType.ORDER, undefined)).toBe(false);
    expect(ambitoValido(SubjectType.TICKET, null)).toBe(false);
  });
});

describe('bandeja: editar un mensaje propio (D-C22)', () => {
  const base = {
    kind: MessageKind.TEXT,
    createdAt: hace(5),
    redactedAt: null,
    deletedAt: null,
    withdrawnAt: null,
  };

  it('texto propio dentro de los 15 minutos', () => {
    expect(() => assertSePuedeEditar(base, ahora)).not.toThrow();
    expect(() =>
      assertSePuedeEditar({ ...base, createdAt: hace(15) }, ahora),
    ).not.toThrow();
  });

  it('pasados los 15 minutos → 409 MESSAGE_EDIT_WINDOW_CLOSED', () => {
    expect(() =>
      assertSePuedeEditar({ ...base, createdAt: hace(16) }, ahora),
    ).toThrow(
      expect.objectContaining({ code: 'MESSAGE_EDIT_WINDOW_CLOSED' }) as Error,
    );
  });

  it('ni sistema, ni automática, ni redactado, ni borrado → 409 MESSAGE_NOT_EDITABLE', () => {
    for (const m of [
      { ...base, kind: MessageKind.SYSTEM },
      { ...base, kind: MessageKind.AUTO_REPLY },
      { ...base, redactedAt: ahora },
      { ...base, withdrawnAt: ahora },
    ]) {
      expect(() => assertSePuedeEditar(m, ahora)).toThrow(
        expect.objectContaining({ code: 'MESSAGE_NOT_EDITABLE' }) as Error,
      );
    }
  });
});

describe('bandeja: borrar un mensaje propio (D-C23)', () => {
  const base: MensajeABorrar = {
    kind: MessageKind.TEXT,
    createdAt: hace(3),
    redactedAt: null,
    deUnPedido: false,
    enUnReclamo: false,
    citado: false,
  };
  const codigo = (m: MensajeABorrar) => {
    try {
      assertSePuedeBorrar(m, ahora);
      return null;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };

  it('texto suelto en los 15 minutos: se borra', () => {
    expect(codigo(base)).toBeNull();
    expect(codigo({ ...base, createdAt: hace(15) })).toBeNull();
  });

  it('cada regla con su código', () => {
    expect(codigo({ ...base, createdAt: hace(16) })).toBe(
      'MESSAGE_DELETE_WINDOW_CLOSED',
    );
    expect(codigo({ ...base, deUnPedido: true })).toBe(
      'MESSAGE_IN_ORDER_CONVERSATION',
    );
    expect(codigo({ ...base, enUnReclamo: true })).toBe(
      'MESSAGE_LINKED_TO_CLAIM',
    );
    expect(codigo({ ...base, citado: true })).toBe('MESSAGE_ALREADY_QUOTED');
    expect(codigo({ ...base, kind: MessageKind.SYSTEM })).toBe(
      'MESSAGE_NOT_EDITABLE',
    );
    expect(codigo({ ...base, redactedAt: ahora })).toBe('MESSAGE_NOT_EDITABLE');
  });

  it('el plazo manda sobre lo demás (el mensaje viejo no se discute)', () => {
    expect(codigo({ ...base, createdAt: hace(60), citado: true })).toBe(
      'MESSAGE_DELETE_WINDOW_CLOSED',
    );
  });
});

describe('bandeja: respuestas guardadas (§6.8)', () => {
  it('lista las variables sin repetir', () => {
    expect(
      variablesDe('Hola {{cliente.nombre}} {{ cliente.nombre }} {{x}}'),
    ).toEqual(['cliente.nombre', 'x']);
  });

  it('una variable fuera de la lista → 400 TEMPLATE_VARIABLE_UNKNOWN', () => {
    expect(() =>
      assertVariablesConocidas('Hola {{cliente.nombre}} de {{empresa.nombre}}'),
    ).not.toThrow();
    expect(() => assertVariablesConocidas('Tu DNI {{cliente.dni}}')).toThrow(
      expect.objectContaining({ code: 'TEMPLATE_VARIABLE_UNKNOWN' }) as Error,
    );
  });

  it('completa las variables y deja vacía la que no aplica', () => {
    expect(
      completarPlantilla(
        'Hola {{cliente.nombre}}, tu pedido {{pedido.numero}} sale {{horario.proximo}}.',
        { 'cliente.nombre': 'Ana', 'horario.proximo': 'mañana a las 08:00' },
      ),
    ).toBe('Hola Ana, tu pedido sale mañana a las 08:00.');
  });
});

describe('bandeja: respuesta automática al cliente (§8.4, D-C29)', () => {
  const base: SituacionDeLaBandeja = {
    enHorario: false,
    fueraDeHorarioHabilitado: true,
    yaSeRespondioEnEstePeriodo: false,
    avisoDeRecibidoHabilitado: false,
    yaSeAvisoRecibido: false,
    empresaYaEscribio: false,
  };

  it('fuera de horario: una sola por período cerrado', () => {
    expect(respuestaAutomaticaDeLaEmpresa(base)).toBe('fuera_de_horario');
    expect(
      respuestaAutomaticaDeLaEmpresa({
        ...base,
        yaSeRespondioEnEstePeriodo: true,
      }),
    ).toBeNull();
    expect(
      respuestaAutomaticaDeLaEmpresa({
        ...base,
        fueraDeHorarioHabilitado: false,
      }),
    ).toBeNull();
  });

  it('en horario: el aviso de recibido una vez y sólo si la empresa no escribió', () => {
    const enHorario = {
      ...base,
      enHorario: true,
      avisoDeRecibidoHabilitado: true,
    };
    expect(respuestaAutomaticaDeLaEmpresa(enHorario)).toBe('recibido');
    expect(
      respuestaAutomaticaDeLaEmpresa({ ...enHorario, yaSeAvisoRecibido: true }),
    ).toBeNull();
    expect(
      respuestaAutomaticaDeLaEmpresa({ ...enHorario, empresaYaEscribio: true }),
    ).toBeNull();
    expect(
      respuestaAutomaticaDeLaEmpresa({
        ...enHorario,
        avisoDeRecibidoHabilitado: false,
      }),
    ).toBeNull();
  });
});
