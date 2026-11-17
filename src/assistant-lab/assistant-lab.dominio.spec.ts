import {
  CausaDeDerivacion,
  DERIVACIONES_SIN_IA,
  MotivoDeDerivacion,
  SIN_USO,
} from '../assistant-ai/asistente-ia.dominio';
import {
  agruparSinRespuesta,
  CAUSAS_SIN_RESPUESTA,
  claveDelBorrador,
  corridaPerdida,
  evaluarCaso,
  ID_DE_GRUPO,
  idDelGrupo,
  idDeLaPregunta,
  idsDeLosGrupos,
  MOTIVOS_SIN_RESPUESTA,
  preguntaNormalizada,
  vistaPrevia,
  type VistaPrevia,
} from './assistant-lab.dominio';

const respuesta = {
  tipo: 'respuesta' as const,
  texto: 'Abrimos de 8 a 20.',
  modelo: 'claude-haiku-5-5',
  uso: SIN_USO,
  herramientas: [],
};

const derivar = (motivo: MotivoDeDerivacion) => ({
  tipo: 'derivar' as const,
  motivo,
  modelo: null,
  uso: SIN_USO,
  herramientas: [],
});

describe('vista previa del probador', () => {
  it('una respuesta: el texto, sin derivar, capa inteligente y las fuentes con su tipo y título', () => {
    expect(
      vistaPrevia({
        resultado: respuesta,
        prendido: true,
        fuentes: [
          { type: 'faq', faqId: 'faq-1', question: '¿Horario?' },
          { type: 'tool', tool: 'estado_de_mi_pedido', orderNumber: 'A1B2C3' },
          { type: 'tool', tool: 'estado_de_mi_pedido' },
          { type: 'tool', tool: 'precios_vigentes' },
          { type: 'tool', tool: 'horarios_y_zonas' },
          { type: 'tool', tool: 'medios_de_pago' },
          { type: 'tool', tool: 'otra_cosa' },
        ],
      }),
    ).toEqual({
      answer: 'Abrimos de 8 a 20.',
      wouldHandOff: false,
      handOffReason: null,
      handOffReasonLabel: null,
      handOffCause: null,
      handOffCauseLabel: null,
      layer: 'ai',
      assistantEnabled: true,
      sources: [
        { type: 'faq', id: 'faq-1', title: '¿Horario?' },
        { type: 'order', id: 'A1B2C3', title: 'Pedido A1B2C3' },
        { type: 'order', id: null, title: 'Pedidos del cliente' },
        { type: 'catalog', id: null, title: 'Precios vigentes' },
        { type: 'schedule', id: null, title: 'Horarios y zonas' },
        { type: 'payment_methods', id: null, title: 'Medios de pago' },
        { type: 'tool', id: null, title: 'otra_cosa' },
      ],
    });
  });

  it('una derivación de la IA: sin texto, con el motivo y la causa en código y en castellano, capa inteligente', () => {
    expect(
      vistaPrevia({
        resultado: {
          ...derivar(MotivoDeDerivacion.REQUESTED),
          causa: CausaDeDerivacion.NO_INFO,
        },
        prendido: false,
        fuentes: [],
      }),
    ).toEqual({
      answer: null,
      wouldHandOff: true,
      handOffReason: 'requested',
      handOffReasonLabel:
        'El asistente no pudo resolverlo o la persona pidió hablar con alguien',
      handOffCause: 'no_info',
      handOffCauseLabel: 'No tenía la información',
      sources: [],
      layer: 'ai',
      assistantEnabled: false,
    });
  });

  it('sin causa (o con otro motivo) la causa sale nula', () => {
    const v = vistaPrevia({
      resultado: derivar(MotivoDeDerivacion.TOOL_ROUNDS),
      prendido: true,
      fuentes: [],
    });
    expect([v.handOffCause, v.handOffCauseLabel]).toEqual([null, null]);
  });

  it.each([...DERIVACIONES_SIN_IA])(
    'si la IA no corrió (%s) la capa es la fija',
    (motivo) => {
      expect(
        vistaPrevia({ resultado: derivar(motivo), prendido: true, fuentes: [] })
          .layer,
      ).toBe('fixed');
    },
  );
});

describe('preguntas sin respuesta: agrupación', () => {
  it('de requested sólo cuentan las causas de lo que no sabía', () => {
    expect(CAUSAS_SIN_RESPUESTA).toEqual(['no_info', 'low_confidence']);
  });

  it('los motivos son los de la IA corriendo sin llegar a respuesta (no los de tope, falla o rescate, ni el pedido de pasar a una persona)', () => {
    expect(MOTIVOS_SIN_RESPUESTA).not.toContain('requested');
    expect([...MOTIVOS_SIN_RESPUESTA].sort()).toEqual(
      [
        'refusal',
        'max_tokens',
        'no_text',
        'invalid_text',
        'tool_rounds',
        'unverified_amount',
      ].sort(),
    );
  });

  it.each([
    ['¿A qué hora abren?', 'Hola!! a que HORA abren??'],
    ['¿A qué hora abren?', 'abren a qué hora, gracias'],
    ['¿Hacen envíos a Garupá?', 'hacen envios a garupa'],
    ['¿Llegan a Oberá?', 'buenas tardes, llegan a obera?'],
  ])('«%s» y «%s» son la misma pregunta', (a, b) => {
    expect(preguntaNormalizada(a)).toBe(preguntaNormalizada(b));
    expect(preguntaNormalizada(a)).not.toBeNull();
  });

  it('preguntas distintas no se juntan', () => {
    expect(preguntaNormalizada('¿A qué hora abren?')).not.toBe(
      preguntaNormalizada('¿A qué hora cierran?'),
    );
  });

  it('sólo saludos, agradecimientos o palabras vacías: no es una pregunta', () => {
    expect(preguntaNormalizada('Hola, buenas tardes')).toBeNull();
    expect(preguntaNormalizada('👍')).toBeNull();
    expect(preguntaNormalizada('y el de la')).toBeNull();
  });

  it('el id es estable y de 32 hexadecimales', () => {
    const id = idDelGrupo('abren hora');
    expect(id).toMatch(ID_DE_GRUPO);
    expect(idDelGrupo('abren hora')).toBe(id);
    expect(idDelGrupo('cierran hora')).not.toBe(id);
  });

  const t = (iso: string) => new Date(iso);

  it('agrupa, cuenta, guarda la primera y la última vez y muestra el texto más reciente; ordena por cantidad', () => {
    const grupos = agruparSinRespuesta(
      [
        { body: 'hacen envios a garupa', createdAt: t('2026-11-10T10:00:00Z') },
        { body: '¿A qué hora abren?', createdAt: t('2026-11-12T10:00:00Z') },
        {
          body: '  ¿Hacen   envíos a Garupá?  ',
          createdAt: t('2026-11-14T10:00:00Z'),
        },
        { body: 'Hacen envíos a Garupá', createdAt: t('2026-11-11T10:00:00Z') },
        { body: 'hola', createdAt: t('2026-11-15T10:00:00Z') },
      ],
      new Map(),
    );
    expect(grupos).toEqual([
      {
        id: idDelGrupo(preguntaNormalizada('hacen envios a garupa')!),
        question: '¿Hacen envíos a Garupá?',
        count: 3,
        firstSeenAt: t('2026-11-10T10:00:00Z'),
        lastSeenAt: t('2026-11-14T10:00:00Z'),
      },
      {
        id: idDelGrupo(preguntaNormalizada('a que hora abren')!),
        question: '¿A qué hora abren?',
        count: 1,
        firstSeenAt: t('2026-11-12T10:00:00Z'),
        lastSeenAt: t('2026-11-12T10:00:00Z'),
      },
    ]);
  });

  it('a igual cantidad, primero el más reciente', () => {
    const grupos = agruparSinRespuesta(
      [
        { body: '¿A qué hora abren?', createdAt: t('2026-11-10T10:00:00Z') },
        { body: '¿Llegan a Oberá?', createdAt: t('2026-11-12T10:00:00Z') },
      ],
      new Map(),
    );
    expect(grupos.map((g) => g.question)).toEqual([
      '¿Llegan a Oberá?',
      '¿A qué hora abren?',
    ]);
  });

  it('a igual cantidad y fecha, por id (orden estable)', () => {
    const cuando = t('2026-11-10T10:00:00Z');
    const grupos = agruparSinRespuesta(
      [
        { body: '¿A qué hora abren?', createdAt: cuando },
        { body: '¿Llegan a Oberá?', createdAt: cuando },
      ],
      new Map(),
    );
    const ids = grupos.map((g) => g.id);
    expect(ids).toEqual([...ids].sort());
    const alReves = agruparSinRespuesta(
      [
        { body: '¿Llegan a Oberá?', createdAt: cuando },
        { body: '¿A qué hora abren?', createdAt: cuando },
      ],
      new Map(),
    );
    expect(alReves.map((g) => g.id)).toEqual(ids);
  });

  it('un grupo resuelto o descartado sólo cuenta lo que llegó después; si no llegó nada, no aparece', () => {
    const abren = idDelGrupo(preguntaNormalizada('a que hora abren')!);
    const garupa = idDelGrupo(preguntaNormalizada('envios a garupa')!);
    const grupos = agruparSinRespuesta(
      [
        { body: '¿A qué hora abren?', createdAt: t('2026-11-10T10:00:00Z') },
        { body: 'a que hora abren', createdAt: t('2026-11-13T10:00:00Z') },
        { body: 'envios a garupa', createdAt: t('2026-11-10T10:00:00Z') },
      ],
      new Map([
        [abren, t('2026-11-12T00:00:00Z')],
        [garupa, t('2026-11-10T10:00:00Z')],
      ]),
    );
    expect(grupos).toEqual([
      expect.objectContaining({
        id: abren,
        count: 1,
        firstSeenAt: t('2026-11-13T10:00:00Z'),
      }),
    ]);
  });

  it('los ids de los grupos de unos mensajes, sin repetir y sin los vacíos', () => {
    expect(
      idsDeLosGrupos([
        { body: '¿A qué hora abren?', createdAt: new Date() },
        { body: 'a que hora abren', createdAt: new Date() },
        { body: 'gracias', createdAt: new Date() },
      ]),
    ).toEqual([idDelGrupo(preguntaNormalizada('a que hora abren')!)]);
  });

  it('idDeLaPregunta: el id de su grupo, o null si no queda nada', () => {
    expect(idDeLaPregunta('¿A qué hora abren?')).toBe(
      idDelGrupo(preguntaNormalizada('abren a que hora')!),
    );
    expect(idDeLaPregunta('hola')).toBeNull();
  });

  it('la clave del borrador de la plataforma cumple el formato de las claves', () => {
    expect(claveDelBorrador('3f2a9c0d1b7e4a5f8c6d2e1f0a9b8c7d')).toBe(
      'sin_respuesta_3f2a9c0d1b7e',
    );
  });
});

describe('lote de regresión: evaluación de un caso', () => {
  const vista = (extra: Partial<VistaPrevia>) => ({
    answer: 'Abrimos de lunes a sábado de 8 a 20 hs.',
    wouldHandOff: false,
    layer: 'ai' as const,
    handOffReasonLabel: null,
    ...extra,
  });

  it('responde y menciona todo (sin distinguir mayúsculas ni tildes): pasa', () => {
    expect(
      evaluarCaso(
        { expected: 'answer', mustMention: ['SÁBADO', '20 hs'] },
        vista({}),
      ),
    ).toEqual({
      outcome: 'passed',
      reason: null,
      detail: 'Respondió y mencionó lo esperado',
      missing: [],
    });
  });

  it('responde pero le falta mencionar algo: no pasa y dice qué', () => {
    expect(
      evaluarCaso(
        { expected: 'answer', mustMention: ['sábado', 'domingo', 'feriados'] },
        vista({}),
      ),
    ).toEqual({
      outcome: 'failed',
      reason: 'missing_mentions',
      detail: 'La respuesta no menciona: domingo, feriados',
      missing: ['domingo', 'feriados'],
    });
  });

  it('se esperaba respuesta y derivó: no pasa, con el motivo', () => {
    expect(
      evaluarCaso(
        { expected: 'answer', mustMention: [] },
        vista({
          answer: null,
          wouldHandOff: true,
          handOffReasonLabel: 'El asistente no llegó a una respuesta',
        }),
      ),
    ).toMatchObject({
      outcome: 'failed',
      reason: 'expected_answer_got_handoff',
      detail:
        'Se esperaba una respuesta y pasó a una persona (El asistente no llegó a una respuesta)',
    });
  });

  it('se esperaba que derivara: pasa si derivó, no pasa si respondió', () => {
    expect(
      evaluarCaso(
        { expected: 'handoff', mustMention: [] },
        vista({ answer: null, wouldHandOff: true }),
      ),
    ).toMatchObject({ outcome: 'passed', reason: null });
    expect(
      evaluarCaso({ expected: 'handoff', mustMention: [] }, vista({})),
    ).toMatchObject({
      outcome: 'failed',
      reason: 'expected_handoff_got_answer',
    });
  });

  it('si la IA no corrió (capa fija) no se puede juzgar: error, aunque se esperara derivar', () => {
    expect(
      evaluarCaso(
        { expected: 'handoff', mustMention: [] },
        vista({
          answer: null,
          wouldHandOff: true,
          layer: 'fixed',
          handOffReasonLabel: 'Se llegó al tope mensual del asistente',
        }),
      ),
    ).toEqual({
      outcome: 'error',
      reason: 'assistant_not_run',
      detail: 'No se pudo probar: Se llegó al tope mensual del asistente',
      missing: [],
    });
  });

  it('textos por omisión si falta el motivo', () => {
    expect(
      evaluarCaso(
        { expected: 'answer', mustMention: [] },
        vista({ layer: 'fixed', answer: null, wouldHandOff: true }),
      ).detail,
    ).toBe('No se pudo probar: el asistente no respondió');
    expect(
      evaluarCaso(
        { expected: 'answer', mustMention: [] },
        vista({ answer: null, wouldHandOff: true }),
      ).detail,
    ).toBe('Se esperaba una respuesta y pasó a una persona (sin motivo)');
  });
});

describe('lote de regresión: latido', () => {
  const AHORA = new Date('2026-11-16T15:00:00Z');
  const hace = (s: number) => new Date(AHORA.getTime() - s * 1000);

  it('en curso sin latido hace más de 2 minutos: perdida', () => {
    expect(
      corridaPerdida({ status: 'running', updatedAt: hace(121) }, AHORA),
    ).toBe(true);
    expect(
      corridaPerdida({ status: 'running', updatedAt: hace(120) }, AHORA),
    ).toBe(false);
  });

  it('una terminada nunca está perdida', () => {
    expect(
      corridaPerdida({ status: 'finished', updatedAt: hace(9999) }, AHORA),
    ).toBe(false);
  });
});
