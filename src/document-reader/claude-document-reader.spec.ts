import Anthropic from '@anthropic-ai/sdk';

import {
  ClaudeDocumentReader,
  ClienteAnthropic,
  TAMANIO_MAXIMO_DOCUMENTO,
  costoEstimado,
  esCuitValido,
  normalizarCampo,
} from './claude-document-reader';
import { TipoDeDocumento } from './tipos-de-documento';

interface Pedido {
  model: string;
  fallbacks: unknown;
  betas: string[];
  output_config: { effort: string; format: { type: string } };
  system: Array<{ cache_control?: { type: string } }>;
  messages: Array<{
    content: Array<{
      type: string;
      text?: string;
      source?: { media_type: string };
    }>;
  }>;
}

const respuesta = (salida: unknown, extra: Record<string, unknown> = {}) => ({
  content: [
    {
      type: 'text' as const,
      text: typeof salida === 'string' ? salida : JSON.stringify(salida),
    },
  ],
  stop_reason: 'end_turn',
  model: 'claude-opus-5-5',
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  ...extra,
});

function armar(resultado: unknown) {
  const create = jest.fn((pedido: Pedido) => {
    void pedido;
    if (typeof resultado === 'function')
      return Promise.reject((resultado as () => Error)());
    return Promise.resolve(resultado);
  });
  const cliente = {
    beta: { messages: { create } },
  } as unknown as ClienteAnthropic;
  const lector = new ClaudeDocumentReader(cliente, {
    modelo: 'claude-opus-5-5',
    esfuerzo: 'medium',
  });
  const pedido = () => create.mock.calls[0][0];
  return { lector, create, pedido };
}

const pdf = {
  buffer: Buffer.from('%PDF-1.4 algo'),
  mimeType: 'application/pdf',
};

describe('ClaudeDocumentReader', () => {
  it('lee un PDF como documento, con fallbacks y el esfuerzo configurado', async () => {
    const { lector, pedido } = armar(
      respuesta({
        tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
        legible: true,
        campos: [{ nombre: 'importe', valor: '38390.00', confianza: 'alta' }],
        avisos: [],
      }),
    );
    const lectura = await lector.leer(pdf);
    expect(lectura).toMatchObject({
      tipo: 'comprobante_de_pago',
      legible: true,
      campos: [{ nombre: 'importe', valor: '38390.00', confianza: 'alta' }],
    });
    expect(pedido().model).toBe('claude-opus-5-5');
    expect(pedido().fallbacks).toBe('default');
    expect(pedido().betas).toContain('server-side-fallback-2026-07-01');
    expect(pedido().output_config.effort).toBe('medium');
    expect(pedido().output_config.format).toMatchObject({
      type: 'json_schema',
    });
    expect(pedido().system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(pedido().messages[0].content[0]).toMatchObject({
      type: 'document',
      source: { media_type: 'application/pdf' },
    });
  });

  it('lee una foto como imagen', async () => {
    const { lector, pedido } = armar(
      respuesta({
        tipo: TipoDeDocumento.OTRO,
        legible: true,
        campos: [],
        avisos: [],
      }),
    );
    await lector.leer({ buffer: Buffer.from('jpg'), mimeType: 'image/jpeg' });
    expect(pedido().messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/jpeg' },
    });
  });

  it('no manda al servicio un formato que no lee, un archivo vacío ni uno demasiado grande', async () => {
    const { lector, create } = armar(respuesta(null));
    await expect(
      lector.leer({ buffer: Buffer.from('x'), mimeType: 'text/plain' }),
    ).resolves.toBeNull();
    await expect(
      lector.leer({ buffer: Buffer.alloc(0), mimeType: 'application/pdf' }),
    ).resolves.toBeNull();
    await expect(
      lector.leer({
        buffer: Buffer.alloc(TAMANIO_MAXIMO_DOCUMENTO + 1),
        mimeType: 'application/pdf',
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('pasa lo esperado y las correcciones anteriores en el pedido', async () => {
    const { lector, pedido } = armar(
      respuesta({
        tipo: TipoDeDocumento.POLIZA,
        legible: true,
        campos: [],
        avisos: [],
      }),
    );
    await lector.leer(pdf, {
      tipoEsperado: TipoDeDocumento.POLIZA,
      pistas: { patente: 'AB123CD' },
      ejemplos: [{ campo: 'prima', leido: '1234', correcto: '12340.00' }],
    });
    const texto = pedido().messages[0].content[1].text ?? '';
    expect(texto).toContain('poliza');
    expect(texto).toContain('patente: AB123CD');
    expect(texto).toContain('se leyó «1234», lo correcto era «12340.00»');
  });

  it('descarta los campos que no son del tipo detectado', async () => {
    const { lector } = armar(
      respuesta({
        tipo: TipoDeDocumento.REVISION_TECNICA,
        legible: true,
        campos: [
          { nombre: 'vencimiento', valor: '2027-03-01', confianza: 'alta' },
          { nombre: 'importe', valor: '100.00', confianza: 'alta' },
        ],
        avisos: [],
      }),
    );
    const lectura = await lector.leer(pdf);
    if (!lectura || 'fallida' in lectura) throw new Error('lectura fallida');
    expect(lectura.campos.map((c) => c.nombre)).toEqual(['vencimiento']);
  });

  it('anula con un aviso el dato que no tiene el formato esperado', async () => {
    const { lector } = armar(
      respuesta({
        tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
        legible: true,
        campos: [{ nombre: 'importe', valor: '38.390,00', confianza: 'alta' }],
        avisos: ['ya venía un aviso'],
      }),
    );
    const lectura = await lector.leer(pdf);
    if (!lectura || 'fallida' in lectura) throw new Error('lectura fallida');
    expect(lectura.campos[0]).toEqual({
      nombre: 'importe',
      valor: null,
      confianza: 'baja',
    });
    expect(lectura.avisos).toEqual([
      'ya venía un aviso',
      expect.stringContaining('«38.390,00»') as string,
    ]);
  });

  it('estima el costo con los tokens de entrada (también los de caché) y de salida', async () => {
    const { lector } = armar(
      respuesta(
        { tipo: TipoDeDocumento.OTRO, legible: true, campos: [], avisos: [] },
        {
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 0,
          },
        },
      ),
    );
    const lectura = await lector.leer(pdf);
    // (1000 × 4 + 2000 × 0,20 de lectura de caché + 500 × 20) / 1e6
    expect(lectura?.uso).toEqual({
      modelo: 'claude-opus-5-5',
      tokensDeEntrada: 3000,
      tokensDeSalida: 500,
      costoUsd: 0.0144,
    });
  });

  it('con el modelo de respaldo usa el texto que viene después del último corte', async () => {
    const valida = {
      tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
      legible: true,
      campos: [{ nombre: 'importe', valor: '29958.00', confianza: 'alta' }],
      avisos: [],
    };
    const conRespaldo = respuesta(valida, {
      model: 'claude-sonnet-5-5',
      content: [
        { type: 'text', text: '{"tipo":"comprobante_de' },
        { type: 'fallback' },
        { type: 'text', text: JSON.stringify(valida) },
      ],
    });
    await expect(armar(conRespaldo).lector.leer(pdf)).resolves.toMatchObject({
      legible: true,
      campos: [{ nombre: 'importe', valor: '29958.00' }],
      uso: { modelo: 'claude-sonnet-5-5' },
    });
  });

  it('una salida cortada por max_tokens es una fallida reintentable con su consumo', async () => {
    await expect(
      armar(
        respuesta(
          '{"tipo":"comprobante_de_pago","legible":true,"campos":[{"nom',
          {
            stop_reason: 'max_tokens',
          },
        ),
      ).lector.leer(pdf),
    ).resolves.toMatchObject({ fallida: true, uso: { costoUsd: 0.008 } });
  });

  it('conserva el consumo: rechazo ilegible, JSON inválido o esquema inválido reintentables; error de API null', async () => {
    await expect(
      armar(respuesta(null, { stop_reason: 'refusal' })).lector.leer(pdf),
    ).resolves.toMatchObject({
      legible: false,
      tipo: 'otro',
      avisos: ['El servicio de lectura no quiso procesar este documento'],
      uso: { costoUsd: 0.008 },
    });
    await expect(armar(respuesta('{')).lector.leer(pdf)).resolves.toMatchObject(
      { fallida: true, uso: { costoUsd: 0.008 } },
    );
    await expect(
      armar(
        respuesta(
          { tipo: TipoDeDocumento.OTRO, legible: false },
          { stop_reason: 'end_turn' },
        ),
      ).lector.leer(pdf),
    ).resolves.toMatchObject({ fallida: true, uso: { costoUsd: 0.008 } });
    const caido = armar(() => {
      throw new Anthropic.APIError(529, undefined, 'Overloaded', new Headers());
    });
    await expect(caido.lector.leer(pdf)).resolves.toBeNull();
    const red = armar(() => {
      throw new Error('ECONNRESET');
    });
    await expect(red.lector.leer(pdf)).resolves.toBeNull();
  });
});

describe('costoEstimado', () => {
  it('la escritura de caché cuesta 1,25 veces la entrada', () => {
    expect(
      costoEstimado('claude-opus-5-5', {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
      }),
    ).toEqual({ costoUsd: 5, precioConocido: true });
  });
  it('el modelo de respaldo se cobra con su propio precio', () => {
    expect(
      costoEstimado('claude-sonnet-5', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toEqual({ costoUsd: 12, precioConocido: true });
  });
  it('un modelo sin precio de lista se estima con la tarifa más alta y lo dice', () => {
    expect(
      costoEstimado('claude-nuevo', {
        input_tokens: 1_000_000,
        output_tokens: 0,
      }),
    ).toEqual({ costoUsd: 10, precioConocido: false });
  });
});

describe('esCuitValido', () => {
  it('verifica el dígito verificador', () => {
    expect(esCuitValido('30500036911')).toBe(true);
    expect(esCuitValido('20123456786')).toBe(true);
    expect(esCuitValido('20123456789')).toBe(false);
    expect(esCuitValido('3050003691')).toBe(false);
  });
});

describe('normalizarCampo', () => {
  it.each([
    ['vencimiento', '2026-02-31'],
    ['periodo', '2026-13'],
    ['cuit_del_emisor', '20-12345678-9'],
    ['patente', 'AAA123ABC'],
    ['fecha_de_pago', 'ayer'],
    ['documento', '123'],
    ['items', 'no es una lista'],
  ])('anula %s = «%s» porque no es un valor válido', (nombre, valor) => {
    const r = normalizarCampo({ nombre, valor, confianza: 'alta' });
    expect(r.campo.valor).toBeNull();
    expect(r.aviso).toBeDefined();
  });
  it.each([
    ['patente', 'AAA123'],
    ['patente', 'AA123BB'],
    ['patente', '123ABC'],
    ['patente', 'A123BCD'],
    ['fecha_de_pago', '2026-11-03T10:42:00-03:00'],
    ['fecha_de_pago', '2026-11-03'],
    ['periodo', '2026-12'],
    ['vencimiento', '2028-02-29'],
  ])('acepta %s = «%s»', (nombre, valor) => {
    expect(
      normalizarCampo({ nombre, valor, confianza: 'alta' }).campo.valor,
    ).toBe(valor);
  });

  it('pasa la patente a mayúsculas sin espacios ni guiones', () => {
    expect(
      normalizarCampo({
        nombre: 'patente',
        valor: ' ab 123-cd ',
        confianza: 'alta',
      }).campo.valor,
    ).toBe('AB123CD');
  });
  it('deja sólo los dígitos del CUIT y del documento', () => {
    expect(
      normalizarCampo({
        nombre: 'cuit_del_emisor',
        valor: '30-71234567-1',
        confianza: 'alta',
      }).campo.valor,
    ).toBe('30712345671');
    expect(
      normalizarCampo({
        nombre: 'documento',
        valor: '30.123.456',
        confianza: 'media',
      }).campo.valor,
    ).toBe('30123456');
  });
  it('una fecha que no es AAAA-MM-DD se anula', () => {
    const r = normalizarCampo({
      nombre: 'vencimiento',
      valor: '01/03/2027',
      confianza: 'alta',
    });
    expect(r.campo.valor).toBeNull();
    expect(r.aviso).toBeDefined();
  });
  it('un campo sin formato definido queda como vino (recortado)', () => {
    expect(
      normalizarCampo({
        nombre: 'aseguradora',
        valor: '  La Segunda ',
        confianza: 'alta',
      }).campo.valor,
    ).toBe('La Segunda');
  });
  it('un valor null queda null y sin aviso', () => {
    expect(
      normalizarCampo({ nombre: 'importe', valor: null, confianza: 'baja' }),
    ).toEqual({
      campo: { nombre: 'importe', valor: null, confianza: 'baja' },
    });
  });
});
