import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import {
  CausaDeDerivacion,
  MotivoDeDerivacion,
} from '../../assistant-ai/asistente-ia.dominio';
import { SIN_HTML } from '../../assistant/dto/assistant-faq.dto';
import { LargoEnLaBase } from '../../assistant/texto-plano';
import { ChatMetricsRangeQueryDto } from '../../chat/presentation/dto/metricas.dto';
import {
  LARGO_DE_LA_MENCION,
  LARGO_DEL_CASO,
  TOPE_DE_CASOS,
  TOPE_DE_MENCIONES,
} from '../assistant-lab.dominio';

const Recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Largo de un mensaje del chat (`CHK_message_texto`). */
const LARGO_DE_LA_PREGUNTA = { min: 1, max: 2000 } as const;

const TIPOS_DE_FUENTE = [
  'faq',
  'order',
  'catalog',
  'schedule',
  'payment_methods',
  'tool',
] as const;

// ---------------------------------------------------------------------------
// Probador
// ---------------------------------------------------------------------------

export class PlatformAssistantPreviewDto {
  @ApiProperty({
    example: '¿Cómo cargo un chofer nuevo?',
    minLength: LARGO_DE_LA_PREGUNTA.min,
    maxLength: LARGO_DE_LA_PREGUNTA.max,
    description:
      'Lo que escribiría la persona, como un mensaje del chat (texto plano).',
  })
  @Recortar()
  @IsString()
  @LargoEnLaBase(LARGO_DE_LA_PREGUNTA.min, LARGO_DE_LA_PREGUNTA.max)
  question!: string;
}

export class AssistantPreviewDto extends PlatformAssistantPreviewDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Un cliente de la distribuidora (`customer_id`, el de `/customers/:id`) como el que pregunta: «estado de mi pedido» lee SUS pedidos. Sin él, contesta como a un cliente anónimo (sin pedidos). 404 si no es de la distribuidora.',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

export class AssistantSourceDto {
  @ApiProperty({
    enum: TIPOS_DE_FUENTE,
    description:
      '`faq`: una pregunta frecuente de la base; `order`: pedidos del cliente; `catalog`: precios vigentes; `schedule`: horarios y zonas; `payment_methods`: medios de pago.',
  })
  type!: (typeof TIPOS_DE_FUENTE)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'El id de la pregunta frecuente o el número corto del pedido; nulo en el resto.',
  })
  id!: string | null;

  @ApiProperty({ example: '¿Hasta qué hora abren?' })
  title!: string;
}

export class AssistantPreviewResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Abrimos de lunes a sábado de 8 a 20.',
    description:
      'Lo que contestaría (texto plano). Nulo si pasaría la conversación a una persona.',
  })
  answer!: string | null;

  @ApiProperty({
    description: 'Si pasaría la conversación a una persona del equipo',
  })
  wouldHandOff!: boolean;

  @ApiProperty({
    enum: MotivoDeDerivacion,
    nullable: true,
    description:
      'Por qué pasaría a una persona (el mismo código que las métricas); nulo si responde.',
  })
  handOffReason!: MotivoDeDerivacion | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'El asistente no pudo resolverlo o la persona pidió hablar con alguien',
  })
  handOffReasonLabel!: string | null;

  @ApiProperty({
    enum: CausaDeDerivacion,
    nullable: true,
    description:
      'Con `requested` (llamó a pasar a una persona), la causa que dio: `no_info` (no tenía la información), `low_confidence` (no estaba seguro), `customer_asked` (la persona lo pidió), `complaint` (reclamo o hay que hacer algo), `other`. Nula en el resto.',
  })
  handOffCause!: CausaDeDerivacion | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'No tenía la información',
  })
  handOffCauseLabel!: string | null;

  @ApiProperty({ type: [AssistantSourceDto] })
  sources!: AssistantSourceDto[];

  @ApiProperty({
    enum: ['fixed', 'ai'],
    description:
      '`ai`: contestó o derivó la capa inteligente; `fixed`: la IA no corrió (tope mensual, sin clave del servicio o falla) y en una conversación real saldrían las respuestas fijas.',
  })
  layer!: 'fixed' | 'ai';

  @ApiProperty({
    description:
      'Si hoy contestaría en una conversación real (función, interruptor del asistente y chat de clientes; en la plataforma, el del soporte). El probador contesta igual, para probarlo antes de prenderlo.',
  })
  assistantEnabled!: boolean;
}

// ---------------------------------------------------------------------------
// Preguntas sin respuesta
// ---------------------------------------------------------------------------

export class QueryUnansweredDto extends ChatMetricsRangeQueryDto {}

export class UnansweredQuestionDto {
  @ApiProperty({
    example: '3f2a9c0d1b7e4a5f8c6d2e1f0a9b8c7d',
    description:
      'Id del grupo (32 hexadecimales): sale del texto normalizado, así que es el mismo entre consultas',
  })
  id!: string;

  @ApiProperty({
    example: '¿Hacen envíos a Garupá?',
    description:
      'La pregunta más reciente del grupo, como la escribió la persona',
  })
  question!: string;

  @ApiProperty({
    example: 4,
    description:
      'Cuántas veces se preguntó en el período (después de la última vez que se resolvió o descartó)',
  })
  count!: number;

  @ApiProperty({ format: 'date-time' }) firstSeenAt!: string;
  @ApiProperty({ format: 'date-time' }) lastSeenAt!: string;
}

export class UnansweredListResponseDto {
  @ApiProperty({ example: '2026-10-18' }) from!: string;
  @ApiProperty({ example: '2026-11-16' }) to!: string;

  @ApiProperty({
    type: [UnansweredQuestionDto],
    description: 'Hasta 100 grupos, los más repetidos primero',
  })
  items!: UnansweredQuestionDto[];

  @ApiProperty({
    description:
      'Se agruparon sólo los 2.000 mensajes más nuevos del período: acortalo para ver el resto',
  })
  truncated!: boolean;
}

export class CreateFaqFromUnansweredDto {
  @ApiProperty({
    example: '¿Hacen envíos a Garupá?',
    minLength: 5,
    maxLength: 200,
    description:
      'La pregunta para la base, confirmada o editada por la persona a partir de la del grupo (el back no la copia sola: puede traer datos personales del cliente). Texto plano, sin HTML.',
  })
  @Recortar()
  @IsString()
  @LargoEnLaBase(5, 200)
  @Matches(SIN_HTML, {
    message:
      'no puede llevar HTML (ni etiquetas como <b> ni códigos como &amp;); escribí texto plano',
  })
  question!: string;
}

// ---------------------------------------------------------------------------
// Lote de regresión
// ---------------------------------------------------------------------------

export class CreateRegressionCaseDto {
  @ApiProperty({
    example: '¿Hasta qué hora toman pedidos?',
    minLength: LARGO_DEL_CASO.min,
    maxLength: LARGO_DEL_CASO.max,
    description:
      'Lo que escribiría un cliente. Único entre los casos vigentes (sin distinguir mayúsculas).',
  })
  @Recortar()
  @IsString()
  @LargoEnLaBase(LARGO_DEL_CASO.min, LARGO_DEL_CASO.max)
  question!: string;

  @ApiProperty({
    enum: ['answer', 'handoff'],
    description:
      '`answer`: tiene que responder; `handoff`: tiene que pasar a una persona',
  })
  @IsIn(['answer', 'handoff'])
  expected!: 'answer' | 'handoff';

  @ApiPropertyOptional({
    type: [String],
    maxItems: TOPE_DE_MENCIONES,
    example: ['20'],
    description: `Sólo con \`answer\`: palabras o frases que la respuesta tiene que mencionar (sin distinguir mayúsculas ni tildes), hasta ${TOPE_DE_MENCIONES} de ${LARGO_DE_LA_MENCION.min} a ${LARGO_DE_LA_MENCION.max} caracteres.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TOPE_DE_MENCIONES)
  @IsString({ each: true })
  @LargoEnLaBase(LARGO_DE_LA_MENCION.min, LARGO_DE_LA_MENCION.max, {
    each: true,
  })
  mustMention?: string[];
}

export class UpdateRegressionCaseDto extends PartialType(
  CreateRegressionCaseDto,
) {}

export class RegressionCaseResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() question!: string;
  @ApiProperty({ enum: ['answer', 'handoff'] }) expected!: 'answer' | 'handoff';
  @ApiProperty({ type: [String] }) mustMention!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class RegressionCaseListResponseDto {
  @ApiProperty({ type: [RegressionCaseResponseDto] })
  items!: RegressionCaseResponseDto[];

  @ApiProperty({
    example: TOPE_DE_CASOS,
    description: 'Tope de casos vigentes',
  })
  limit!: number;
}

export class RegressionCaseResultDto extends OmitType(
  AssistantPreviewResponseDto,
  ['assistantEnabled'] as const,
) {
  @ApiProperty({ format: 'uuid' }) caseId!: string;

  @ApiProperty({ description: 'La pregunta como estaba al correrla' })
  question!: string;

  @ApiProperty({ enum: ['answer', 'handoff'] }) expected!: 'answer' | 'handoff';
  @ApiProperty({ type: [String] }) mustMention!: string[];

  @ApiProperty({
    enum: ['passed', 'failed', 'error'],
    description:
      '`error`: no se pudo juzgar (la IA no corrió, se terminó el cupo de pruebas o el caso falló)',
  })
  outcome!: 'passed' | 'failed' | 'error';

  @ApiProperty({
    enum: [
      'expected_answer_got_handoff',
      'expected_handoff_got_answer',
      'missing_mentions',
      'assistant_not_run',
      'test_quota_reached',
      'case_error',
    ],
    nullable: true,
  })
  reason!: string | null;

  @ApiProperty({
    example: 'La respuesta no menciona: 20',
    description: 'Por qué, en castellano',
  })
  detail!: string;

  @ApiProperty({
    type: [String],
    description: 'Lo que faltó mencionar (con `missing_mentions`)',
  })
  missing!: string[];
}

export class RegressionRunResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;

  @ApiProperty({
    enum: ['running', 'finished', 'failed'],
    description:
      '`running`: en curso (los resultados se van sumando); `failed`: se cortó por un error o porque el proceso se reinició',
  })
  status!: 'running' | 'finished' | 'failed';

  @ApiProperty({ description: 'Casos a correr' }) total!: number;
  @ApiProperty() passed!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ description: 'Casos que no se pudieron juzgar' })
  errored!: number;

  @ApiProperty({ type: [RegressionCaseResultDto] })
  results!: RegressionCaseResultDto[];

  @ApiProperty({ format: 'date-time' }) startedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt!: string | null;
}
