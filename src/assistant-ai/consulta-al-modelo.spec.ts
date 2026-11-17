import Anthropic from '@anthropic-ai/sdk';
import {
  CausaDeDerivacion,
  FORMATO_DE_LA_RESPUESTA,
  MotivoDeDerivacion,
} from './asistente-ia.dominio';
import {
  type ClienteDelAsistente,
  ConsultaAlAsistente,
  type ConsultaAlModelo,
  motivoDelError,
} from './consulta-al-modelo';
import {
  herramientasDelCanal,
  type ResultadoDeHerramienta,
} from './herramientas';
import { armarSystem } from './prompt';

const MODELO = 'claude-haiku-5-5';

function uso(
  entrada: number,
  salida: number,
  cacheLeida: number | null = 0,
  cacheEscrita: number | null = 0,
): Anthropic.Usage {
  return {
    input_tokens: entrada,
    output_tokens: salida,
    cache_read_input_tokens: cacheLeida,
    cache_creation_input_tokens: cacheEscrita,
  } as Anthropic.Usage;
}

function respuesta(
  stop_reason: Anthropic.StopReason,
  content: Array<Record<string, unknown>>,
  u: Anthropic.Usage = uso(100, 20),
): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODELO,
    stop_reason,
    stop_sequence: null,
    content,
    usage: u,
  } as unknown as Anthropic.Message;
}

const texto = (t: string) => ({ type: 'text', text: t, citations: null });
/** El último turno: la salida estructurada `{ respuesta, preguntas }` (4d). */
const final = (t: string, preguntas: number[] = []) =>
  texto(JSON.stringify({ respuesta: t, preguntas }));
const herramienta = (id: string, name: string, input: unknown = {}) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function armar(...respuestas: Array<Anthropic.Message | Error>) {
  const create = jest.fn();
  for (const r of respuestas) {
    if (r instanceof Error) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  const cliente = { messages: { create } } as unknown as ClienteDelAsistente;
  const ejecutar = jest.fn(
    (nombre: string): Promise<ResultadoDeHerramienta> =>
      Promise.resolve({ datos: { de: nombre }, error: false }),
  );
  const consulta: ConsultaAlModelo = {
    system: armarSystem(
      {
        canal: 'clientes',
        nombreDelAsistente: 'Asistente de Gas',
        nombreDeQuienAtiende: 'Gas',
      },
      [],
    ),
    mensajes: [{ role: 'user', content: [{ type: 'text', text: 'Hola' }] }],
    herramientas: herramientasDelCanal('clientes'),
    ejecutar,
  };
  return {
    servicio: new ConsultaAlAsistente(cliente),
    create,
    ejecutar,
    consulta,
  };
}

type Llamada = [
  Anthropic.MessageCreateParamsNonStreaming,
  Record<string, unknown>,
];

describe('ConsultaAlAsistente (cliente de Anthropic simulado)', () => {
  it('respuesta de texto: Haiku 5.5, esfuerzo bajo, 8 s sin reintentos, herramientas estrictas y sin parámetros de muestreo', async () => {
    const { servicio, create, consulta } = armar(
      respuesta(
        'end_turn',
        [final('Abrimos a las **9**.')],
        uso(50, 10, 400, 0),
      ),
    );
    const r = await servicio.consultar(consulta);
    expect(r).toEqual({
      tipo: 'respuesta',
      texto: 'Abrimos a las 9.',
      modelo: MODELO,
      uso: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 400,
        cacheCreationTokens: 0,
      },
      herramientas: [],
      preguntas: [],
      fuentes: [],
    });
    const [params, opciones] = create.mock.calls[0] as Llamada;
    expect(params).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      // 4d: la respuesta final con salida estructurada (texto y preguntas usadas).
      output_config: { effort: 'low', format: FORMATO_DE_LA_RESPUESTA },
      tool_choice: { type: 'auto' },
      system: consulta.system,
      messages: consulta.mensajes,
    });
    for (const prohibido of ['temperature', 'top_p', 'top_k', 'thinking']) {
      expect(params).not.toHaveProperty(prohibido);
    }
    // Sin prefill: el último turno que se manda es de la persona.
    expect(params.messages[params.messages.length - 1].role).toBe('user');
    expect(params.tools?.every((t) => (t as Anthropic.Tool).strict)).toBe(true);
    expect(
      params.tools?.every(
        (t) =>
          (t as Anthropic.Tool).input_schema.additionalProperties === false,
      ),
    ).toBe(true);
    expect(opciones).toEqual({ timeout: 8000, maxRetries: 0 });
    expect(servicio.disponible).toBe(true);
  });

  it('tool_use: corre cada herramienta, devuelve tool_result (los errores con is_error) y vuelve a consultar con la respuesta anterior', async () => {
    const pedido = herramienta('tu_1', 'estado_de_mi_pedido', {
      pedido: 'ABC123',
    });
    const precios = herramienta('tu_2', 'precios_vigentes');
    const { servicio, create, ejecutar, consulta } = armar(
      respuesta(
        'tool_use',
        [texto('Ya miro'), pedido, precios],
        uso(100, 30, 0, 500),
      ),
      respuesta(
        'end_turn',
        [final('Tu pedido está en camino.')],
        uso(80, 15, 500, 0),
      ),
    );
    ejecutar
      .mockResolvedValueOnce({ datos: [{ estado: 'En camino' }], error: false })
      .mockResolvedValueOnce({ datos: { error: 'No se pudo' }, error: true });
    const r = await servicio.consultar(consulta);
    expect(r).toMatchObject({
      tipo: 'respuesta',
      texto: 'Tu pedido está en camino.',
      herramientas: ['estado_de_mi_pedido', 'precios_vigentes'],
      uso: {
        inputTokens: 180,
        outputTokens: 45,
        cacheReadTokens: 500,
        cacheCreationTokens: 500,
      },
    });
    expect(ejecutar).toHaveBeenNthCalledWith(1, 'estado_de_mi_pedido', {
      pedido: 'ABC123',
    });
    const [segunda] = create.mock.calls[1] as Llamada;
    expect(segunda.messages).toEqual([
      ...consulta.mensajes,
      { role: 'assistant', content: [texto('Ya miro'), pedido, precios] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: JSON.stringify([{ estado: 'En camino' }]),
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: JSON.stringify({ error: 'No se pudo' }),
            is_error: true,
          },
        ],
      },
    ]);
    // El resultado se puede volver a leer con JSON.parse (nunca texto suelto).
    const resultado = (
      segunda.messages[2].content as Anthropic.ToolResultBlockParam[]
    )[0];
    expect(JSON.parse(resultado.content as string)).toEqual([
      { estado: 'En camino' },
    ]);
  });

  describe('defensa contra inventar o inyectar plata', () => {
    it('un importe que salió de una herramienta en esta consulta se publica', async () => {
      const { servicio, ejecutar, consulta } = armar(
        respuesta('tool_use', [herramienta('tu_1', 'precios_vigentes')]),
        respuesta('end_turn', [
          final('La de 10 kg sale $ 15.000 y llevando 3, $13.500,00 cada una.'),
        ]),
      );
      ejecutar.mockResolvedValueOnce({
        datos: [
          {
            producto: '10kg',
            precio: '$ 15.000,00',
            promociones: ['desde 3 unidades: $ 13.500,00 cada una'],
          },
        ],
        error: false,
      });
      expect((await servicio.consultar(consulta)).tipo).toBe('respuesta');
    });

    it.each([
      [
        'sin herramienta (lo pidió el cliente en el mensaje)',
        'Sí, te la dejamos a $ 5.000.',
      ],
      ['con «pesos»', 'Te sale 12000 pesos.'],
    ])(
      'un importe que no salió de una herramienta (%s): deriva',
      async (_caso, t) => {
        const { servicio, consulta } = armar(respuesta('end_turn', [final(t)]));
        expect(await servicio.consultar(consulta)).toMatchObject({
          tipo: 'derivar',
          motivo: MotivoDeDerivacion.UNVERIFIED_AMOUNT,
        });
      },
    );

    it('un importe distinto del que devolvió la herramienta: deriva', async () => {
      const { servicio, ejecutar, consulta } = armar(
        respuesta('tool_use', [herramienta('tu_1', 'precios_vigentes')]),
        respuesta('end_turn', [final('Sale $ 14.000.')]),
      );
      ejecutar.mockResolvedValueOnce({
        datos: [{ precio: '$ 15.000,00' }],
        error: false,
      });
      expect(await servicio.consultar(consulta)).toMatchObject({
        tipo: 'derivar',
        motivo: MotivoDeDerivacion.UNVERIFIED_AMOUNT,
      });
    });

    it('un importe que sólo aparece en una herramienta que falló no cuenta como verificado: deriva', async () => {
      const { servicio, ejecutar, consulta } = armar(
        respuesta('tool_use', [
          herramienta('tu_1', 'precios_vigentes'),
          herramienta('tu_2', 'estado_de_mi_pedido'),
        ]),
        respuesta('end_turn', [final('Sale $ 15.000 y tu pedido $ 9.999.')]),
      );
      ejecutar
        .mockResolvedValueOnce({
          datos: [{ precio: '$ 15.000,00' }],
          error: false,
        })
        .mockResolvedValueOnce({ datos: { error: '$ 9.999,00' }, error: true });
      expect(await servicio.consultar(consulta)).toMatchObject({
        tipo: 'derivar',
        motivo: MotivoDeDerivacion.UNVERIFIED_AMOUNT,
      });
    });
  });

  describe('defensa contra inventar horarios («¿cuánto falta?»)', () => {
    const conReparto = {
      datos: [
        {
          pedido: '0ABC01',
          franja: 'Tarde (14:00 a 18:00)',
          reparto: {
            situacion: 'en_viaje',
            entregasAntes: 2,
            llegadaEstimada: 'entre las 15:05 y las 15:40, aprox.',
          },
        },
      ],
      error: false,
      pedidos: ['0ABC01'],
    };

    it('la franja estimada que dio estado_de_mi_pedido se publica', async () => {
      const { servicio, ejecutar, consulta } = armar(
        respuesta('tool_use', [herramienta('tu_1', 'estado_de_mi_pedido')]),
        respuesta('end_turn', [
          final(
            'Ya salió: llega entre las 15:05 y las 15:40, aprox. Hay 2 entregas antes que la tuya.',
          ),
        ]),
      );
      ejecutar.mockResolvedValueOnce(conReparto);
      expect(await servicio.consultar(consulta)).toMatchObject({
        tipo: 'respuesta',
        texto:
          'Ya salió: llega entre las 15:05 y las 15:40, aprox. Hay 2 entregas antes que la tuya.',
      });
    });

    it('una hora puntual que ninguna herramienta dio: deriva', async () => {
      const { servicio, ejecutar, consulta } = armar(
        respuesta('tool_use', [herramienta('tu_1', 'estado_de_mi_pedido')]),
        respuesta('end_turn', [final('Llega a las 15:22 en punto.')]),
      );
      ejecutar.mockResolvedValueOnce(conReparto);
      expect(await servicio.consultar(consulta)).toMatchObject({
        tipo: 'derivar',
        motivo: MotivoDeDerivacion.INVALID_TEXT,
      });
    });

    it('una hora sin herramienta, inventada: deriva; la que dijo la persona o la base, no', async () => {
      const inventada = armar(
        respuesta('end_turn', [final('Te llega a las 16:30.')]),
      );
      expect(
        await inventada.servicio.consultar(inventada.consulta),
      ).toMatchObject({
        tipo: 'derivar',
        motivo: MotivoDeDerivacion.INVALID_TEXT,
      });
      const repetida = armar(
        respuesta('end_turn', [
          final('No puedo asegurarte que llegue antes de las 16:30.'),
        ]),
      );
      repetida.consulta.mensajes = [
        { role: 'user', content: '¿Llega antes de las 16:30?' },
      ];
      expect(
        await repetida.servicio.consultar(repetida.consulta),
      ).toMatchObject({ tipo: 'respuesta' });
      const deLaBase = armar(
        respuesta('end_turn', [final('Atendemos de 8:00 a 20:00.')]),
      );
      deLaBase.consulta.system = armarSystem(
        {
          canal: 'clientes',
          nombreDelAsistente: 'Asistente de Gas',
          nombreDeQuienAtiende: 'Gas',
        },
        [
          {
            question: '¿Qué horario tienen?',
            answer: 'Atendemos de 08:00 a 20:00.',
            position: 1,
          },
        ],
      );
      expect(
        await deLaBase.servicio.consultar(deLaBase.consulta),
      ).toMatchObject({ tipo: 'respuesta' });
    });
  });

  it('una herramienta que tira vuelve al modelo como error y la respuesta sigue', async () => {
    const { servicio, ejecutar, create, consulta } = armar(
      respuesta('tool_use', [herramienta('tu_1', 'medios_de_pago')]),
      respuesta('end_turn', [final('Efectivo.')]),
    );
    ejecutar.mockRejectedValueOnce(new Error('se cayó la base'));
    const r = await servicio.consultar(consulta);
    expect(r.tipo).toBe('respuesta');
    const [segunda] = create.mock.calls[1] as Llamada;
    expect(segunda.messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: JSON.stringify({ error: 'No se pudo consultar ahora' }),
        is_error: true,
      },
    ]);
  });

  it('pasar_a_persona: deriva sin correr nada más', async () => {
    const { servicio, ejecutar, consulta } = armar(
      respuesta('tool_use', [
        herramienta('tu_1', 'precios_vigentes'),
        herramienta('tu_2', 'pasar_a_persona', { motivo: 'reclamo' }),
      ]),
    );
    const r = await servicio.consultar(consulta);
    expect(r).toMatchObject({
      tipo: 'derivar',
      motivo: MotivoDeDerivacion.REQUESTED,
      modelo: MODELO,
      herramientas: ['pasar_a_persona'],
    });
    expect(ejecutar).not.toHaveBeenCalled();
  });

  it('pasar_a_persona trae el resumen y el motivo para el equipo (4c), limpios y recortados, en la misma consulta', async () => {
    const { servicio, create, consulta } = armar(
      respuesta('tool_use', [
        herramienta('tu_1', 'pasar_a_persona', {
          motivo: '  pide **hablar** con alguien ',
          resumen:
            'Pide 2×10 kg.\n\n  Pregunta por la demora del pedido A1B2C3.',
        }),
      ]),
    );
    expect(await servicio.consultar(consulta)).toMatchObject({
      tipo: 'derivar',
      motivo: MotivoDeDerivacion.REQUESTED,
      resumen: 'Pide 2×10 kg.\nPregunta por la demora del pedido A1B2C3.',
      detalle: 'pide hablar con alguien',
    });
    // Sin una segunda llamada para el resumen.
    expect(create).toHaveBeenCalledTimes(1);
    const pasar = (
      (create.mock.calls[0] as Llamada)[0].tools as Anthropic.Tool[]
    ).find((t) => t.name === 'pasar_a_persona');
    expect(pasar?.strict).toBe(true);
    expect(pasar?.input_schema.required).toEqual([
      'causa',
      'motivo',
      'resumen',
    ]);
    const causa = (
      pasar?.input_schema.properties as Record<string, { enum?: string[] }>
    ).causa;
    expect(causa.enum).toEqual([
      'no_info',
      'low_confidence',
      'customer_asked',
      'complaint',
      'other',
    ]);
  });

  it.each([
    ['no_info', CausaDeDerivacion.NO_INFO],
    ['low_confidence', CausaDeDerivacion.LOW_CONFIDENCE],
    ['complaint', CausaDeDerivacion.COMPLAINT],
    ['cualquier_cosa', CausaDeDerivacion.OTHER],
    [undefined, CausaDeDerivacion.OTHER],
  ])(
    'pasar_a_persona con causa %s: la trae (lo que no es de la lista es other)',
    async (crudo, causa) => {
      const { servicio, consulta } = armar(
        respuesta('tool_use', [
          herramienta('tu_1', 'pasar_a_persona', {
            causa: crudo,
            motivo: 'x',
            resumen: 'y',
          }),
        ]),
      );
      expect(await servicio.consultar(consulta)).toMatchObject({
        tipo: 'derivar',
        motivo: MotivoDeDerivacion.REQUESTED,
        causa,
      });
    },
  );

  it.each([
    'Todavía no tengo información sobre eso, pero quedó registrada tu consulta.',
    'Tomé nota y alguien del equipo te va a contactar.',
    'Ya le avisé al equipo.',
    'Te paso con alguien de ventas.',
  ])(
    'una respuesta que dice que registró o derivó algo («%s») no se publica: deriva',
    async (t) => {
      const { servicio, consulta } = armar(respuesta('end_turn', [final(t)]));
      expect(await servicio.consultar(consulta)).toMatchObject({
        tipo: 'derivar',
        motivo: MotivoDeDerivacion.INVALID_TEXT,
      });
    },
  );

  it('pasar_a_persona con un resumen con HTML o vacío: deriva sin resumen (la nota lleva el motivo)', async () => {
    const { servicio, consulta } = armar(
      respuesta('tool_use', [
        herramienta('tu_1', 'pasar_a_persona', {
          motivo: '',
          resumen: '<b>hola</b>',
        }),
      ]),
    );
    expect(await servicio.consultar(consulta)).toMatchObject({
      tipo: 'derivar',
      resumen: null,
      detalle: null,
    });
  });

  it('fuentes (4d): las preguntas frecuentes que dijo usar (enteros positivos, sin repetir) y las herramientas que dieron datos, con sus pedidos', async () => {
    const { servicio, ejecutar, consulta } = armar(
      respuesta('tool_use', [
        herramienta('tu_1', 'estado_de_mi_pedido'),
        herramienta('tu_2', 'precios_vigentes'),
        herramienta('tu_3', 'medios_de_pago'),
      ]),
      respuesta('tool_use', [herramienta('tu_4', 'estado_de_mi_pedido')]),
      respuesta('end_turn', [
        texto(
          JSON.stringify({
            respuesta: 'Tu pedido está en camino.',
            preguntas: [2, 2, 0, -1, 1.5, 3],
          }),
        ),
      ]),
    );
    ejecutar
      .mockResolvedValueOnce({
        datos: [{ pedido: 'A1B2C3' }, { pedido: 'D4E5F6' }],
        error: false,
        pedidos: ['A1B2C3', 'D4E5F6'],
      })
      .mockResolvedValueOnce({ datos: [], error: false })
      .mockResolvedValueOnce({ datos: { error: 'No' }, error: true })
      .mockResolvedValueOnce({
        datos: [{ pedido: 'A1B2C3' }],
        error: false,
        pedidos: ['A1B2C3'],
      });
    expect(await servicio.consultar(consulta)).toMatchObject({
      tipo: 'respuesta',
      preguntas: [2, 3],
      // La que falló no es fuente; el mismo pedido dos veces, una sola.
      fuentes: [
        { tool: 'estado_de_mi_pedido', pedido: 'A1B2C3' },
        { tool: 'estado_de_mi_pedido', pedido: 'D4E5F6' },
        { tool: 'precios_vigentes' },
      ],
    });
  });

  it.each([
    ['texto suelto (no es la salida estructurada)', 'Abrimos a las 9.'],
    ['JSON sin respuesta', JSON.stringify({ preguntas: [] })],
    [
      'respuesta que no es texto',
      JSON.stringify({ respuesta: 3, preguntas: [] }),
    ],
    ['una lista', '[]'],
  ])(
    'salida final inválida (%s): deriva invalid_text',
    async (_caso, crudo) => {
      const { servicio, consulta } = armar(
        respuesta('end_turn', [texto(crudo)]),
      );
      expect(await servicio.consultar(consulta)).toMatchObject({
        tipo: 'derivar',
        motivo: MotivoDeDerivacion.INVALID_TEXT,
      });
    },
  );

  it('respuesta vacía dentro de la salida estructurada: deriva no_text', async () => {
    const { servicio, consulta } = armar(respuesta('end_turn', [final('   ')]));
    expect(await servicio.consultar(consulta)).toMatchObject({
      tipo: 'derivar',
      motivo: MotivoDeDerivacion.NO_TEXT,
    });
  });

  it('más de 3 vueltas de herramientas: deriva (4 consultas como máximo)', async () => {
    const vuelta = () =>
      respuesta('tool_use', [herramienta('tu', 'horarios_y_zonas')]);
    const { servicio, create, consulta } = armar(
      vuelta(),
      vuelta(),
      vuelta(),
      vuelta(),
    );
    const r = await servicio.consultar(consulta);
    expect(r).toMatchObject({
      tipo: 'derivar',
      motivo: MotivoDeDerivacion.TOOL_ROUNDS,
    });
    expect(create).toHaveBeenCalledTimes(4);
    expect(r.uso.inputTokens).toBe(400);
  });

  it.each([
    ['refusal', respuesta('refusal', []), MotivoDeDerivacion.REFUSAL],
    [
      'max_tokens',
      respuesta('max_tokens', [texto('Bueno, mirá…')]),
      MotivoDeDerivacion.MAX_TOKENS,
    ],
    [
      'sin texto',
      respuesta('end_turn', [final('  ')]),
      MotivoDeDerivacion.NO_TEXT,
    ],
    [
      'texto con HTML',
      respuesta('end_turn', [final('<b>Hola</b>')]),
      MotivoDeDerivacion.INVALID_TEXT,
    ],
    [
      'tool_use sin herramientas',
      respuesta('tool_use', [texto('…')]),
      MotivoDeDerivacion.NO_TEXT,
    ],
    ['pause_turn', respuesta('pause_turn', []), MotivoDeDerivacion.NO_TEXT],
  ])('%s: deriva y registra el consumo', async (_caso, r, motivo) => {
    const { servicio, consulta } = armar(r);
    const resultado = await servicio.consultar(consulta);
    expect(resultado).toMatchObject({
      tipo: 'derivar',
      motivo,
      modelo: MODELO,
    });
    expect(resultado.uso.inputTokens).toBe(100);
  });

  it.each([
    [
      'timeout',
      new Anthropic.APIConnectionTimeoutError(),
      MotivoDeDerivacion.TIMEOUT,
    ],
    [
      '429',
      new Anthropic.RateLimitError(429, {}, 'rate', new Headers()),
      MotivoDeDerivacion.RATE_LIMITED,
    ],
    [
      '5xx',
      new Anthropic.InternalServerError(500, {}, 'boom', new Headers()),
      MotivoDeDerivacion.API_ERROR,
    ],
    [
      'sin conexión',
      new Anthropic.APIConnectionError({ message: 'x' }),
      MotivoDeDerivacion.API_ERROR,
    ],
    ['otro error', new Error('raro'), MotivoDeDerivacion.API_ERROR],
  ])(
    'falla de la API (%s): deriva, nunca tira',
    async (_caso, error, motivo) => {
      const { servicio, consulta } = armar(error);
      await expect(servicio.consultar(consulta)).resolves.toEqual({
        tipo: 'derivar',
        motivo,
        modelo: null,
        uso: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        herramientas: [],
      });
    },
  );

  it('el error de la segunda vuelta conserva lo consumido en la primera', async () => {
    const { servicio, consulta } = armar(
      respuesta(
        'tool_use',
        [herramienta('tu_1', 'medios_de_pago')],
        uso(70, 9, null, null),
      ),
      new Anthropic.APIConnectionTimeoutError(),
    );
    const r = await servicio.consultar(consulta);
    expect(r).toMatchObject({
      tipo: 'derivar',
      motivo: MotivoDeDerivacion.TIMEOUT,
      modelo: MODELO,
      uso: {
        inputTokens: 70,
        outputTokens: 9,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      herramientas: ['medios_de_pago'],
    });
  });

  it('sin clave de la API: deriva sin consultar', async () => {
    const servicio = new ConsultaAlAsistente(null);
    expect(servicio.disponible).toBe(false);
    const { consulta } = armar();
    await expect(servicio.consultar(consulta)).resolves.toMatchObject({
      tipo: 'derivar',
      motivo: MotivoDeDerivacion.UNAVAILABLE,
      modelo: null,
    });
  });

  it('el motivo sale de la clase del error, no del texto', () => {
    const conTextoEngañoso = new Error('Request timed out (429 rate limit)');
    expect(motivoDelError(conTextoEngañoso)).toBe(MotivoDeDerivacion.API_ERROR);
  });
});
