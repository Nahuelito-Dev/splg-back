import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import {
  ArchivoDeDocumento,
  LecturaFallida,
  CampoLeido,
  DocumentReaderPort,
  LecturaDeDocumento,
  OpcionesDeLectura,
  AVISO_DE_NEGATIVA,
} from './document-reader.port';
import {
  CATALOGO_DE_DOCUMENTOS,
  NOMBRES_DE_CAMPOS,
  TipoDeDocumento,
  camposDe,
} from './tipos-de-documento';

/** Cliente de Anthropic inyectable: los tests lo reemplazan y no gastan crédito. */
export const CLIENTE_ANTHROPIC = 'CLIENTE_ANTHROPIC';
export type ClienteAnthropic = Pick<Anthropic, 'beta'>;

/** Modelo y esfuerzo del lector; se cambian por entorno sin tocar el código. */
export interface ConfiguracionDelLector {
  modelo: string;
  esfuerzo: 'low' | 'medium' | 'high';
}
export const CONFIGURACION_DEL_LECTOR = 'CONFIGURACION_DEL_LECTOR';

/** Tope propio, muy por debajo del límite de la API (32 MB por pedido). */
export const TAMANIO_MAXIMO_DOCUMENTO = 10 * 1024 * 1024;

const TIPOS_DE_IMAGEN = ['image/jpeg', 'image/png', 'image/webp'] as const;
type TipoDeImagen = (typeof TIPOS_DE_IMAGEN)[number];
const esImagen = (mimeType: string): mimeType is TipoDeImagen =>
  (TIPOS_DE_IMAGEN as readonly string[]).includes(mimeType);

/**
 * Precios de lista en dólares por millón de tokens, para estimar el costo. La
 * lectura de caché se cobra aparte (si no se indica, el 10 % de la entrada) y la
 * escritura de caché, 1,25 veces la entrada. Si responde un modelo que no está
 * acá (p. ej. el de respaldo), se estima con el más caro y se avisa en el log.
 */
interface Precio {
  entrada: number;
  salida: number;
  lecturaDeCache?: number;
}
const PRECIOS: Record<string, Precio> = {
  'claude-opus-5-5': { entrada: 4, salida: 20, lecturaDeCache: 0.2 },
  'claude-opus-5': { entrada: 5, salida: 25 },
  'claude-opus-4-8': { entrada: 5, salida: 25 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10, lecturaDeCache: 0.2 },
  'claude-sonnet-5': { entrada: 2, salida: 10 },
  'claude-haiku-5-5': { entrada: 0.1, salida: 0.5 },
  'claude-fable-5-1': { entrada: 10, salida: 50, lecturaDeCache: 0.25 },
};
const PRECIO_DESCONOCIDO: Precio = { entrada: 10, salida: 50 };
const RECARGO_ESCRITURA_DE_CACHE = 1.25;

export interface UsoDeTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Costo estimado en dólares de una respuesta, según el modelo que la dio. */
export function costoEstimado(
  modelo: string,
  uso: UsoDeTokens,
): { costoUsd: number; precioConocido: boolean } {
  const precio = PRECIOS[modelo];
  const p = precio ?? PRECIO_DESCONOCIDO;
  const lectura = p.lecturaDeCache ?? p.entrada * 0.1;
  const costo =
    uso.input_tokens * p.entrada +
    (uso.cache_read_input_tokens ?? 0) * lectura +
    (uso.cache_creation_input_tokens ?? 0) *
      p.entrada *
      RECARGO_ESCRITURA_DE_CACHE +
    uso.output_tokens * p.salida;
  return {
    costoUsd: Number((costo / 1_000_000).toFixed(6)),
    precioConocido: Boolean(precio),
  };
}

const TIPOS = Object.values(TipoDeDocumento) as [
  TipoDeDocumento,
  ...TipoDeDocumento[],
];
const NOMBRES = [...NOMBRES_DE_CAMPOS] as [string, ...string[]];

const LecturaDelModelo = z.object({
  tipo: z.enum(TIPOS).describe('Qué documento es, del catálogo'),
  legible: z
    .boolean()
    .describe('false si está borroso, cortado, en blanco o no es un documento'),
  campos: z
    .array(
      z.object({
        nombre: z.enum(NOMBRES),
        valor: z.string().nullable(),
        confianza: z.enum(['alta', 'media', 'baja']),
      }),
    )
    .describe('Sólo los campos del tipo detectado'),
  avisos: z
    .array(z.string())
    .describe(
      'Dudas, datos ilegibles o diferencias con lo esperado, una frase cada uno',
    ),
});

const catalogo = CATALOGO_DE_DOCUMENTOS.map(
  (d) =>
    `- ${d.tipo}: ${d.descripcion}.` +
    (d.campos.length
      ? '\n' +
        d.campos.map((c) => `    · ${c.nombre}: ${c.descripcion}`).join('\n')
      : ''),
).join('\n');

const INSTRUCCIONES = `Leés documentos que sube el administrador de una distribuidora de gas de Argentina: comprobantes de pago, facturas y remitos de proveedores, pólizas, revisiones técnicas y cédulas de vehículos, licencias de conducir y aptos médicos del personal.

Primero reconocé qué documento es, del catálogo. Después extraé sólo los campos de ese tipo, con el formato que indica cada uno.

Reglas:
- Extraé sólo lo que figura en el documento. Si un dato no está o no se lee, devolvé valor null. No inventes ni completes datos.
- Importes argentinos: "$ 38.390,00" es "38390.00". Si hay varios importes, tomá el total abonado, no subtotales ni saldos.
- confianza por campo: alta si el dato se lee sin dudas; media si hay algo dudoso (un dígito borroso); baja si es una suposición.
- legible: false si el documento está borroso, cortado, en blanco o no corresponde a ningún tipo del catálogo.
- Si te pasan lo que el sistema espera encontrar y lo leído no coincide, decilo en avisos con los dos valores.
- Los avisos van en castellano, una frase cada uno, sin nombres internos de campos.

Catálogo:
${catalogo}`;

const ISO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_FECHA_Y_HORA =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?(Z|[+-]\d{2}:\d{2})$/;
const IMPORTE = /^\d+(\.\d{1,2})?$/;
/** Autos: AAA123 (viejo) y AA123BB (Mercosur). Motos: 123AAA (viejo) y A123BCD (Mercosur). */
const PATENTE =
  /^([A-Z]{3}\d{3}|[A-Z]{2}\d{3}[A-Z]{2}|\d{3}[A-Z]{3}|[A-Z]\d{3}[A-Z]{3})$/;

/** La fecha existe en el calendario (no 2026-02-31). */
function fechaReal(anio: number, mes: number, dia: number): boolean {
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    d.getUTCFullYear() === anio &&
    d.getUTCMonth() === mes - 1 &&
    d.getUTCDate() === dia
  );
}

function esFecha(valor: string): boolean {
  const m = ISO_FECHA.exec(valor);
  return Boolean(m && fechaReal(Number(m[1]), Number(m[2]), Number(m[3])));
}

function esFechaYHora(valor: string): boolean {
  const m = ISO_FECHA_Y_HORA.exec(valor);
  return Boolean(m && fechaReal(Number(m[1]), Number(m[2]), Number(m[3])));
}

/** CUIT/CUIL con su dígito verificador (módulo 11). */
export function esCuitValido(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(cuit[i]), 0);
  const resto = 11 - (suma % 11);
  const verificador = resto === 11 ? 0 : resto === 10 ? 9 : resto;
  return verificador === Number(cuit[10]);
}

const validaciones: Record<string, (valor: string) => boolean> = {
  importe: (v) => IMPORTE.test(v),
  total: (v) => IMPORTE.test(v),
  iva: (v) => IMPORTE.test(v),
  prima: (v) => IMPORTE.test(v),
  fecha: esFecha,
  fecha_de_revision: esFecha,
  vencimiento: esFecha,
  vigencia_desde: esFecha,
  vigencia_hasta: esFecha,
  fecha_de_pago: (v) => esFechaYHora(v) || esFecha(v),
  periodo: (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v),
  cuit_del_destinatario: esCuitValido,
  cuit_del_emisor: esCuitValido,
  documento: (v) => /^\d{7,8}$/.test(v),
  anio: (v) => /^(19|20)\d{2}$/.test(v),
  patente: (v) => PATENTE.test(v),
  items: (v) => {
    try {
      return Array.isArray(JSON.parse(v));
    } catch {
      return false;
    }
  },
};

/** Deja cada valor en su forma canónica; si no la cumple, lo anula con un aviso. */
export function normalizarCampo(campo: CampoLeido): {
  campo: CampoLeido;
  aviso?: string;
} {
  if (campo.valor === null) return { campo };
  let valor = campo.valor.trim();
  if (campo.nombre.startsWith('cuit') || campo.nombre === 'documento') {
    valor = valor.replace(/\D/g, '');
  }
  if (campo.nombre === 'patente') {
    valor = valor.toUpperCase().replace(/[\s-]/g, '');
  }
  const valida = validaciones[campo.nombre];
  if (valida && !valida(valor)) {
    return {
      campo: { ...campo, valor: null, confianza: 'baja' },
      aviso: `Se leyó «${campo.valor}» en un dato que no tiene un valor válido: revisalo a mano`,
    };
  }
  return { campo: { ...campo, valor } };
}

/**
 * Lector de documentos con Claude. Cualquier falla devuelve null: quien subió
 * el documento carga los datos a mano y nada se bloquea.
 */
@Injectable()
export class ClaudeDocumentReader extends DocumentReaderPort {
  readonly disponible = true;
  private readonly logger = new Logger(ClaudeDocumentReader.name);

  constructor(
    @Inject(CLIENTE_ANTHROPIC) private readonly cliente: ClienteAnthropic,
    @Inject(CONFIGURACION_DEL_LECTOR)
    private readonly configuracion: ConfiguracionDelLector,
  ) {
    super();
  }

  async leer(
    archivo: ArchivoDeDocumento,
    opciones: OpcionesDeLectura = {},
  ): Promise<LecturaDeDocumento | LecturaFallida | null> {
    const bloque = this.bloqueDelArchivo(archivo);
    if (!bloque) return null;
    try {
      // `parse` arroja antes de entregarnos usage si el JSON no valida. Con
      // `create` la respuesta (y su consumo) siempre llega hasta acá.
      const respuesta = await this.cliente.beta.messages.create({
        model: this.configuracion.modelo,
        max_tokens: 8000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: this.configuracion.esfuerzo,
          format: betaZodOutputFormat(LecturaDelModelo),
        },
        system: [
          {
            type: 'text',
            text: INSTRUCCIONES,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [bloque, { type: 'text', text: this.pedido(opciones) }],
          },
        ],
      });
      if (respuesta.stop_reason === 'refusal') {
        this.logger.warn('El servicio de lectura declinó el documento');
        return this.inutil(respuesta.model, respuesta.usage, AVISO_DE_NEGATIVA);
      }
      // Con el respaldo del servidor, lo que vale es la salida del último modelo: el texto
      // que viene después del último bloque `fallback` (lo anterior se descarta).
      const bloques = respuesta.content;
      const corte = bloques.map((b) => b.type).lastIndexOf('fallback');
      const texto = bloques
        .slice(corte + 1)
        .filter(
          (b): b is Extract<(typeof bloques)[number], { type: 'text' }> =>
            b.type === 'text',
        )
        .pop();
      const resultado =
        respuesta.stop_reason === 'max_tokens' || !texto
          ? null
          : LecturaDelModelo.safeParse(
              (() => {
                try {
                  return JSON.parse(texto.text) as unknown;
                } catch {
                  return null;
                }
              })(),
            );
      if (!resultado || !resultado.success) {
        this.logger.warn(
          `Lectura sin resultado válido (stop_reason=${respuesta.stop_reason})`,
        );
        return {
          fallida: true,
          uso: this.uso(respuesta.model, respuesta.usage),
        };
      }
      return this.armar(resultado.data, respuesta.model, respuesta.usage);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        this.logger.warn(
          `El servicio de lectura respondió ${error.status}: ${error.message}`,
        );
      } else {
        this.logger.warn(`No se pudo leer el documento: ${String(error)}`);
      }
      return null;
    }
  }

  private uso(modelo: string, usage: UsoDeTokens) {
    return this.armar(
      { tipo: TipoDeDocumento.OTRO, legible: false, campos: [], avisos: [] },
      modelo,
      usage,
    ).uso;
  }

  private inutil(
    modelo: string,
    usage: UsoDeTokens,
    aviso: string,
  ): LecturaDeDocumento {
    const uso = this.uso(modelo, usage);
    return {
      tipo: TipoDeDocumento.OTRO,
      legible: false,
      campos: [],
      avisos: [aviso],
      uso,
    };
  }

  private bloqueDelArchivo(archivo: ArchivoDeDocumento) {
    if (
      archivo.buffer.length === 0 ||
      archivo.buffer.length > TAMANIO_MAXIMO_DOCUMENTO
    ) {
      return null;
    }
    const data = archivo.buffer.toString('base64');
    if (archivo.mimeType === 'application/pdf') {
      return {
        type: 'document' as const,
        source: {
          type: 'base64' as const,
          media_type: 'application/pdf' as const,
          data,
        },
      };
    }
    if (esImagen(archivo.mimeType)) {
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: archivo.mimeType, data },
      };
    }
    return null;
  }

  private pedido(opciones: OpcionesDeLectura): string {
    const partes = ['Leé este documento.'];
    if (opciones.tipoEsperado) {
      partes.push(
        `El sistema espera un documento de tipo ${opciones.tipoEsperado}.`,
      );
    }
    if (opciones.pistas && Object.keys(opciones.pistas).length) {
      partes.push(
        'Lo que el sistema espera encontrar:\n' +
          Object.entries(opciones.pistas)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join('\n'),
      );
    }
    if (opciones.ejemplos?.length) {
      partes.push(
        'Correcciones que hizo el administrador en lecturas anteriores de documentos como este (usalas para no repetir el error):\n' +
          opciones.ejemplos
            .map(
              (e) =>
                `- ${e.campo}: se leyó «${e.leido ?? 'nada'}», lo correcto era «${e.correcto}»`,
            )
            .join('\n'),
      );
    }
    return partes.join('\n\n');
  }

  private armar(
    leido: z.infer<typeof LecturaDelModelo>,
    modelo: string,
    usage: UsoDeTokens,
  ): LecturaDeDocumento {
    const permitidos = new Set(camposDe(leido.tipo).map((c) => c.nombre));
    const avisos = [...leido.avisos];
    const campos: CampoLeido[] = [];
    for (const crudo of leido.campos) {
      if (!permitidos.has(crudo.nombre)) continue;
      const { campo, aviso } = normalizarCampo(crudo);
      campos.push(campo);
      if (aviso) avisos.push(aviso);
    }
    const { costoUsd, precioConocido } = costoEstimado(modelo, usage);
    if (!precioConocido) {
      this.logger.warn(
        `Sin precio de lista para ${modelo}: el costo se estimó con la tarifa más alta`,
      );
    }
    return {
      tipo: leido.tipo,
      legible: leido.legible,
      campos,
      avisos,
      uso: {
        modelo,
        tokensDeEntrada:
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0),
        tokensDeSalida: usage.output_tokens,
        costoUsd,
      },
    };
  }
}
