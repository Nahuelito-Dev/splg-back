import {
  atiendeElCanal,
  ambitoValido,
  assertSePuedeBorrar,
  assertSePuedeConsultarPorElPedido,
  assertSePuedeEditar,
  assertVariablesConocidas,
  assertNombreDelAsistente,
  assertVariablesDelNombreDelAsistente,
  canalesQueAtiende,
  completarPlantilla,
  esRespuestaAutomatica,
  type MensajeABorrar,
  nombreDelAsistente,
  nombreDelAsistenteValido,
  permisoDelCanal,
  respuestaAutomaticaDeLaEmpresa,
  type SituacionDeLaBandeja,
  variablesDe,
} from './bandeja';
import {
  Channel,
  MessageKind,
  Party,
  SubjectType,
  SystemCode,
} from './chat.enums';
import {
  NombreDelAsistenteInvalidoError,
  VariableDelNombreDelAsistenteError,
} from './chat.errors';

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

describe('bandeja: el asistente de la empresa (D-B5, D-B8)', () => {
  it('se firma con su nombre o con «Asistente de» la empresa', () => {
    expect(nombreDelAsistente(null, 'Gas Norte')).toBe(
      'Asistente de Gas Norte',
    );
    expect(
      nombreDelAsistente('Gasito de {{ empresa.nombre }}', 'Gas Norte'),
    ).toBe('Gasito de Gas Norte');
    expect(nombreDelAsistente('Gasito', 'Gas Norte')).toBe('Gasito');
  });

  it('el nombre sólo admite {{empresa.nombre}}: es una firma (400 TEMPLATE_VARIABLE_UNKNOWN)', () => {
    expect(() =>
      assertVariablesDelNombreDelAsistente('Asistente de {{empresa.nombre}}'),
    ).not.toThrow();
    const error = (nombre: string): unknown => {
      try {
        assertVariablesDelNombreDelAsistente(nombre);
      } catch (e) {
        return e;
      }
      return null;
    };
    const conCliente = error('Hola {{cliente.nombre}}');
    expect(conCliente).toBeInstanceOf(VariableDelNombreDelAsistenteError);
    expect(conCliente).toMatchObject({ code: 'TEMPLATE_VARIABLE_UNKNOWN' });
    expect((conCliente as Error).message).toContain('{{cliente.nombre}}');
    expect(error('{{x}}')).toMatchObject({
      code: 'TEMPLATE_VARIABLE_UNKNOWN',
    });
  });

  it('es respuesta automática la de fuera de horario y el aviso de recibido; no los demás avisos ni las personas', () => {
    const sistema = { senderParty: Party.SYSTEM, systemCode: null };
    expect(
      esRespuestaAutomatica({ ...sistema, kind: MessageKind.AUTO_REPLY }),
    ).toBe(true);
    expect(
      esRespuestaAutomatica({
        ...sistema,
        kind: MessageKind.SYSTEM,
        systemCode: SystemCode.RECEIVED_ACK,
      }),
    ).toBe(true);
    expect(
      esRespuestaAutomatica({
        ...sistema,
        kind: MessageKind.SYSTEM,
        systemCode: SystemCode.CLAIM_CREATED,
      }),
    ).toBe(false);
    expect(
      esRespuestaAutomatica({
        senderParty: Party.COMPANY,
        kind: MessageKind.TEXT,
        systemCode: null,
      }),
    ).toBe(false);
  });

  it('el nombre tiene de 2 a 60 caracteres contados como la base (code points) y va en una sola línea', () => {
    expect(nombreDelAsistenteValido('Gasito')).toBe(true);
    expect(nombreDelAsistenteValido('Ñandú')).toBe(true);
    expect(nombreDelAsistenteValido('G')).toBe(false);
    expect(nombreDelAsistenteValido('x'.repeat(60))).toBe(true);
    expect(nombreDelAsistenteValido('x'.repeat(61))).toBe(false);
    // «❤️» son dos caracteres para la base (U+2764 + U+FE0F); `@Length` de
    // class-validator no cuenta el U+FE0F y lo dejaría pasar con 61.
    expect(nombreDelAsistenteValido(`${'x'.repeat(58)}❤️`)).toBe(true);
    expect(nombreDelAsistenteValido(`${'x'.repeat(59)}❤️`)).toBe(false);
    // Un emoji fuera del plano básico es un solo carácter, no dos de UTF-16.
    expect(nombreDelAsistenteValido(`${'x'.repeat(59)}🔥`)).toBe(true);
    for (const corte of [
      '\n',
      '\r',
      '\t',
      '\u0085',
      '\u2028',
      '\u2029',
      '\u0007',
    ]) {
      expect(nombreDelAsistenteValido(`Gas${corte}ito`)).toBe(false);
    }
  });

  it('assertNombreDelAsistente: 400 ASSISTANT_NAME_INVALID por largo o línea, y TEMPLATE_VARIABLE_UNKNOWN por variable', () => {
    expect(() =>
      assertNombreDelAsistente('Gasito de {{empresa.nombre}}'),
    ).not.toThrow();
    expect(() => assertNombreDelAsistente('Gas\u2028ito')).toThrow(
      NombreDelAsistenteInvalidoError,
    );
    expect(() => assertNombreDelAsistente('G')).toThrow(
      NombreDelAsistenteInvalidoError,
    );
    expect(() => assertNombreDelAsistente('Hola {{cliente.nombre}}')).toThrow(
      VariableDelNombreDelAsistenteError,
    );
  });
});

describe('bandeja: quién atiende un canal (asignar)', () => {
  const rol = (todos: boolean, permisos: string[]) => ({
    todos,
    permisos: new Set(permisos),
  });

  it('con el permiso del canal, sí; con el del otro canal, no', () => {
    const clientes = rol(false, ['mensajes.clientes']);
    expect(atiendeElCanal(clientes, Channel.STAFF_CUSTOMER)).toBe(true);
    expect(atiendeElCanal(clientes, Channel.STAFF_DRIVER)).toBe(false);
    const choferes = rol(false, ['mensajes.choferes']);
    expect(atiendeElCanal(choferes, Channel.STAFF_DRIVER)).toBe(true);
    expect(atiendeElCanal(choferes, Channel.STAFF_CUSTOMER)).toBe(false);
  });

  it('el rol de sistema atiende los dos; uno sin permisos de mensajes, ninguno', () => {
    for (const canal of [
      Channel.STAFF_CUSTOMER,
      Channel.STAFF_DRIVER,
    ] as const) {
      expect(atiendeElCanal(rol(true, []), canal)).toBe(true);
      expect(atiendeElCanal(rol(false, ['mensajes.configurar']), canal)).toBe(
        false,
      );
    }
  });
});
