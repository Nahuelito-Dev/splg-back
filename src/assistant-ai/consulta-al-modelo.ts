import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLIENTE_ANTHROPIC } from '../document-reader/claude-document-reader';
import {
  CausaDeDerivacion,
  causaDeDerivacion,
  FORMATO_DE_LA_RESPUESTA,
  type FuenteDeHerramienta,
  importesNoVerificados,
  LARGO_DEL_DETALLE,
  LARGO_DEL_RESUMEN,
  leerRespuestaEstructurada,
  MAX_TOKENS_DEL_ASISTENTE,
  MODELO_DEL_ASISTENTE,
  MotivoDeDerivacion,
  prometeUnaAccion,
  RespuestaDelModelo,
  SIN_USO,
  sumarUso,
  textoParaElEquipo,
  textoPublicable,
  TIMEOUT_DE_LA_CONSULTA_MS,
  type UsoDelModelo,
  VUELTAS_DE_HERRAMIENTAS,
} from './asistente-ia.dominio';
import { PASAR_A_PERSONA, type ResultadoDeHerramienta } from './herramientas';

/** Lo único del cliente de Anthropic que usa el asistente (los tests lo simulan). */
export type ClienteDelAsistente = Pick<Anthropic, 'messages'>;

/** Lo que arma el servicio para una consulta. */
export interface ConsultaAlModelo {
  system: Anthropic.TextBlockParam[];
  mensajes: Anthropic.MessageParam[];
  herramientas: Anthropic.Tool[];
  /** Corre una herramienta pedida por el modelo. Nunca tira: un error vuelve como `is_error`. */
  ejecutar: (nombre: string, input: unknown) => Promise<ResultadoDeHerramienta>;
}

function usoDe(u: Anthropic.Usage): UsoDelModelo {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Por qué falló la llamada, por la clase del error (nunca por el texto). */
export function motivoDelError(error: unknown): MotivoDeDerivacion {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return MotivoDeDerivacion.TIMEOUT;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return MotivoDeDerivacion.RATE_LIMITED;
  }
  return MotivoDeDerivacion.API_ERROR;
}

/**
 * La consulta a Claude Haiku 5.5 con el loop de herramientas (§4.1.2): una
 * llamada por vuelta, 8 s cada una y sin reintentos. El último turno sale con
 * salida estructurada (`{ respuesta, preguntas }`: el texto y las preguntas
 * frecuentes que usó, 4d); de las herramientas se anotan las que dieron datos
 * (con los pedidos). Al derivar, `pasar_a_persona` trae el resumen para el
 * equipo (4c), en la misma consulta: sin una segunda llamada. Cualquier cosa
 * que no sea un texto publicable termina en derivar: `pasar_a_persona`, `refusal`
 * (Haiku no tiene respaldo del servidor), `max_tokens`, sin texto, HTML, un
 * importe que no salió de una herramienta en esta consulta, un texto que
 * dice que registró o derivó algo (`prometeUnaAccion`), más de 3 vueltas
 * de herramientas, timeout o error de la API. Nunca tira.
 */
@Injectable()
export class ConsultaAlAsistente {
  private readonly logger = new Logger(ConsultaAlAsistente.name);

  constructor(
    @Optional()
    @Inject(CLIENTE_ANTHROPIC)
    private readonly cliente: ClienteDelAsistente | null,
  ) {}

  /** Sin `ANTHROPIC_API_KEY` no hay cliente: el asistente deriva sin consultar. */
  get disponible(): boolean {
    return Boolean(this.cliente);
  }

  async consultar(consulta: ConsultaAlModelo): Promise<RespuestaDelModelo> {
    let uso = SIN_USO;
    let modelo: string | null = null;
    const herramientas: string[] = [];
    const fuentes: FuenteDeHerramienta[] = [];
    const derivar = (
      motivo: MotivoDeDerivacion,
      dePasar?: {
        resumen: string | null;
        detalle: string | null;
        causa: CausaDeDerivacion;
      },
    ): RespuestaDelModelo => ({
      tipo: 'derivar',
      motivo,
      modelo,
      uso,
      herramientas,
      ...(dePasar ?? {}),
    });
    if (!this.cliente) return derivar(MotivoDeDerivacion.UNAVAILABLE);

    let mensajes = [...consulta.mensajes];
    // Lo que devolvieron las herramientas en ESTA consulta: de ahí, y sólo de
    // ahí, puede salir un importe de la respuesta.
    const datos: string[] = [];
    for (let vuelta = 0; ; vuelta += 1) {
      let respuesta: Anthropic.Message;
      try {
        respuesta = await this.cliente.messages.create(
          {
            model: MODELO_DEL_ASISTENTE,
            max_tokens: MAX_TOKENS_DEL_ASISTENTE,
            output_config: { effort: 'low', format: FORMATO_DE_LA_RESPUESTA },
            system: consulta.system,
            tools: consulta.herramientas,
            tool_choice: { type: 'auto' },
            messages: mensajes,
          },
          { timeout: TIMEOUT_DE_LA_CONSULTA_MS, maxRetries: 0 },
        );
      } catch (error) {
        const motivo = motivoDelError(error);
        this.logger.warn(
          `La consulta al asistente falló (${motivo}${error instanceof Anthropic.APIError && error.status ? `, ${error.status}` : ''})`,
        );
        return derivar(motivo);
      }
      uso = sumarUso(uso, usoDe(respuesta.usage));
      modelo = respuesta.model;

      switch (respuesta.stop_reason) {
        case 'refusal':
          return derivar(MotivoDeDerivacion.REFUSAL);
        case 'max_tokens':
          return derivar(MotivoDeDerivacion.MAX_TOKENS);
        case 'tool_use': {
          const pedidos = respuesta.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          );
          if (pedidos.length === 0) return derivar(MotivoDeDerivacion.NO_TEXT);
          const pasar = pedidos.find((p) => p.name === PASAR_A_PERSONA);
          if (pasar) {
            herramientas.push(PASAR_A_PERSONA);
            const input = (pasar.input ?? {}) as Record<string, unknown>;
            return derivar(MotivoDeDerivacion.REQUESTED, {
              resumen: textoParaElEquipo(input.resumen, LARGO_DEL_RESUMEN),
              detalle: textoParaElEquipo(input.motivo, LARGO_DEL_DETALLE),
              causa: causaDeDerivacion(input.causa),
            });
          }
          if (vuelta >= VUELTAS_DE_HERRAMIENTAS) {
            return derivar(MotivoDeDerivacion.TOOL_ROUNDS);
          }
          const resultados: Anthropic.ToolResultBlockParam[] = [];
          for (const p of pedidos) {
            herramientas.push(p.name);
            const r = await this.correr(consulta, p);
            const contenido = JSON.stringify(r.datos);
            if (!r.error) {
              datos.push(contenido);
              anotarFuente(fuentes, p.name, r.pedidos);
            }
            resultados.push({
              type: 'tool_result',
              tool_use_id: p.id,
              content: contenido,
              ...(r.error ? { is_error: true } : {}),
            });
          }
          mensajes = [
            ...mensajes,
            { role: 'assistant', content: respuesta.content },
            { role: 'user', content: resultados },
          ];
          continue;
        }
        case 'end_turn':
        case 'stop_sequence': {
          const crudo = respuesta.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          if (crudo.trim().length === 0) {
            return derivar(MotivoDeDerivacion.NO_TEXT);
          }
          const estructurada = leerRespuestaEstructurada(crudo);
          if (estructurada === null) {
            return derivar(MotivoDeDerivacion.INVALID_TEXT);
          }
          if (estructurada.respuesta.trim().length === 0) {
            return derivar(MotivoDeDerivacion.NO_TEXT);
          }
          const texto = textoPublicable(estructurada.respuesta);
          if (texto === null) return derivar(MotivoDeDerivacion.INVALID_TEXT);
          if (prometeUnaAccion(texto)) {
            this.logger.warn(
              'La respuesta del asistente dice que registró o derivó algo que no hizo: se deriva',
            );
            return derivar(MotivoDeDerivacion.INVALID_TEXT);
          }
          if (importesNoVerificados(texto, datos).length > 0) {
            this.logger.warn(
              'La respuesta del asistente menciona un importe que no salió de una herramienta: se deriva',
            );
            return derivar(MotivoDeDerivacion.UNVERIFIED_AMOUNT);
          }
          return {
            tipo: 'respuesta',
            texto,
            modelo: respuesta.model,
            uso,
            herramientas,
            preguntas: estructurada.preguntas,
            fuentes,
          };
        }
        default:
          return derivar(MotivoDeDerivacion.NO_TEXT);
      }
    }
  }

  /** Una herramienta que falla vuelve al modelo como error, no corta la respuesta. */
  private async correr(
    consulta: ConsultaAlModelo,
    pedido: Anthropic.ToolUseBlock,
  ): Promise<ResultadoDeHerramienta> {
    try {
      return await consulta.ejecutar(pedido.name, pedido.input);
    } catch {
      this.logger.warn(`La herramienta ${pedido.name} falló`);
      return {
        datos: { error: 'No se pudo consultar ahora' },
        error: true,
      };
    }
  }
}

/** Una herramienta que dio datos, una vez (y una vez por pedido). */
function anotarFuente(
  fuentes: FuenteDeHerramienta[],
  tool: string,
  pedidos: readonly string[] | undefined,
): void {
  const nuevas: FuenteDeHerramienta[] =
    pedidos && pedidos.length > 0
      ? pedidos.map((pedido) => ({ tool, pedido }))
      : [{ tool }];
  for (const f of nuevas) {
    if (!fuentes.some((x) => x.tool === f.tool && x.pedido === f.pedido)) {
      fuentes.push(f);
    }
  }
}
