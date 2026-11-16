import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import {
  CLAVE,
  HTML,
  LARGO_DE_LA_CLAVE,
  LARGOS,
  LargoEnLaBase,
} from '../texto-plano';

const Recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/**
 * Texto plano (DISENO-CH-BOT §5): ni etiquetas HTML (`<b>`, `</p>`, `<!--`) ni
 * entidades (`&amp;`, `&lt`, `&#60;`). Un `<` o un `&` sueltos pasan. La misma
 * regla está en el servicio y en la base (`CHK_assistant_faq_sin_html`).
 */
export const SIN_HTML = new RegExp(`^(?![\\s\\S]*(?:${HTML.source}))`);

const MENSAJE_SIN_HTML =
  'no puede llevar HTML (ni etiquetas como <b> ni códigos como &amp;); escribí texto plano';

/** Alta de una pregunta frecuente de la distribuidora. */
export class CreateAssistantFaqDto {
  @ApiProperty({
    example: '¿Hasta qué hora toman pedidos?',
    minLength: 5,
    maxLength: 200,
    description:
      'Texto plano, sin HTML. Única en la base (sin distinguir mayúsculas).',
  })
  @Recortar()
  @IsString()
  @LargoEnLaBase(LARGOS.question.min, LARGOS.question.max)
  @Matches(SIN_HTML, { message: MENSAJE_SIN_HTML })
  question!: string;

  @ApiProperty({
    example:
      'De lunes a sábado, de 8 a 20. Los pedidos fuera de horario se entregan al día siguiente.',
    minLength: 1,
    maxLength: 1500,
    description: 'Texto plano, sin HTML.',
  })
  @Recortar()
  @IsString()
  @LargoEnLaBase(LARGOS.answer.min, LARGOS.answer.max)
  @Matches(SIN_HTML, { message: MENSAJE_SIN_HTML })
  answer!: string;
}

/** Edición: lo que no viene queda como estaba. */
export class UpdateAssistantFaqDto extends PartialType(CreateAssistantFaqDto) {}

/** La clave de una pregunta de OrixTech o de una pregunta de ejemplo. */
class ConClave extends CreateAssistantFaqDto {
  @ApiProperty({
    example: 'medios_de_pago',
    minLength: LARGO_DE_LA_CLAVE.min,
    maxLength: LARGO_DE_LA_CLAVE.max,
    description:
      'Clave de la pregunta: minúsculas, números y guiones bajos. Única entre las vigentes y no cambia (para cambiarla, se da de baja y se crea otra).',
  })
  @Recortar()
  @IsString()
  @Length(LARGO_DE_LA_CLAVE.min, LARGO_DE_LA_CLAVE.max)
  @Matches(CLAVE)
  key!: string;
}

/**
 * Alta de una pregunta de la base de la plataforma (OrixTech): contesta a las
 * distribuidoras en el soporte y nunca se copia a una (D-B6).
 */
export class CreatePlatformAssistantFaqDto extends ConClave {}

/** La clave no cambia. */
export class UpdatePlatformAssistantFaqDto extends UpdateAssistantFaqDto {}

/**
 * Alta de una pregunta de ejemplo para distribuidoras (D-B7). La clave es la
 * que evita duplicarla al copiarla a una distribuidora.
 */
export class CreateAssistantFaqTemplateDto extends ConClave {}

/** La clave no cambia; el orden es el de alta. */
export class UpdateAssistantFaqTemplateDto extends UpdateAssistantFaqDto {}

export class AssistantFaqResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'medios_de_pago',
    description:
      'Clave de la pregunta de ejemplo de la que salió; nula si la escribió la distribuidora.',
  })
  key!: string | null;

  @ApiProperty() question!: string;
  @ApiProperty() answer!: string;

  @ApiProperty({
    example: 1,
    description:
      'Orden en la base (1 es la primera); la lista sale ordenada por él',
  })
  position!: number;

  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PlatformAssistantFaqResponseDto extends OmitType(
  AssistantFaqResponseDto,
  ['key'] as const,
) {
  @ApiProperty({ example: 'soporte_facturacion' }) key!: string;
}

export class AssistantFaqListResponseDto {
  @ApiProperty({ type: [AssistantFaqResponseDto] })
  items!: AssistantFaqResponseDto[];

  @ApiProperty({
    example: 3,
    description:
      'Versión de la base: sube con cada cambio y nunca baja (0 si nunca se cargó nada). El asistente la usa para saber si su contexto sigue vigente.',
  })
  version!: number;

  @ApiProperty({ example: 200, description: 'Tope de preguntas de la base' })
  limit!: number;
}

export class PlatformAssistantFaqListResponseDto extends OmitType(
  AssistantFaqListResponseDto,
  ['items'] as const,
) {
  @ApiProperty({ type: [PlatformAssistantFaqResponseDto] })
  items!: PlatformAssistantFaqResponseDto[];
}

export class CopyAssistantTemplatesResponseDto {
  @ApiProperty({
    example: 5,
    description: 'Preguntas de ejemplo copiadas ahora',
  })
  copied!: number;

  @ApiProperty({
    example: 0,
    description:
      'Preguntas de ejemplo que no se copiaron porque la base ya tiene esa clave o esa misma pregunta',
  })
  skipped!: number;

  @ApiProperty({
    example: 4,
    description: 'Versión de la base después de copiar',
  })
  version!: number;
}

/** Pregunta de ejemplo, como la administra la plataforma. */
export class PlatformAssistantFaqTemplateResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'medios_de_pago' }) key!: string;
  @ApiProperty({ example: '¿Qué medios de pago aceptan?' }) question!: string;
  @ApiProperty() answer!: string;

  @ApiProperty({
    example: 1,
    description:
      'Orden en el catálogo (1 es la primera); la lista y la copia salen ordenadas por él',
  })
  position!: number;

  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PlatformAssistantFaqTemplateListResponseDto {
  @ApiProperty({ type: [PlatformAssistantFaqTemplateResponseDto] })
  items!: PlatformAssistantFaqTemplateResponseDto[];

  @ApiProperty({
    example: 200,
    description: 'Tope de preguntas de ejemplo del catálogo',
  })
  limit!: number;
}

/** Pregunta de ejemplo, como la ve una distribuidora antes de copiarla. */
export class AssistantFaqTemplateResponseDto {
  @ApiProperty({ example: 'medios_de_pago' }) key!: string;
  @ApiProperty({ example: '¿Qué medios de pago aceptan?' }) question!: string;
  @ApiProperty() answer!: string;

  @ApiProperty({ example: 1, description: 'Orden en el catálogo' })
  position!: number;

  @ApiProperty({
    example: false,
    description:
      'Si la base de la distribuidora ya tiene esa clave o esa misma pregunta: `from-templates` no la copia',
  })
  alreadyInBase!: boolean;
}

export class AssistantFaqTemplateListResponseDto {
  @ApiProperty({ type: [AssistantFaqTemplateResponseDto] })
  items!: AssistantFaqTemplateResponseDto[];
}
