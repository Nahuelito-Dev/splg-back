import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { HTML, LARGOS, LargoEnLaBase } from '../texto-plano';

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

/**
 * Edición: lo que no viene queda como estaba. Los DTO de edición no tienen
 * valores por omisión (un `PartialType` copiaría el de `useAsTemplate` y un
 * PATCH de otra cosa lo pisaría).
 */
export class UpdateAssistantFaqDto extends PartialType(CreateAssistantFaqDto) {}

/** Alta de una pregunta de la base de la plataforma (OrixTech). */
export class CreatePlatformAssistantFaqDto extends CreateAssistantFaqDto {
  @ApiProperty({
    example: 'medios_de_pago',
    maxLength: 60,
    description:
      'Clave de la pregunta: minúsculas, números y guiones bajos. Única entre las vigentes y no cambia (para cambiarla, se da de baja y se crea otra). Es la que evita duplicar la plantilla al copiarla a una distribuidora.',
  })
  @Recortar()
  @IsString()
  @Length(2, 60)
  @Matches(/^[a-z0-9]+(_[a-z0-9]+)*$/)
  key!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Si se ofrece como plantilla a las distribuidoras (`from-templates`). Con `false` queda sólo en la base del soporte de la plataforma.',
  })
  @IsOptional()
  @IsBoolean()
  useAsTemplate: boolean = true;
}

/**
 * La clave no cambia. Se arma sobre la edición de la empresa (sin
 * inicializadores) y no sobre el alta de la plataforma: `PartialType` y
 * `OmitType` heredan el `= true` de `useAsTemplate`, y con `transform` del
 * pipe un PATCH de la respuesta volvía a marcarla como plantilla.
 */
export class UpdatePlatformAssistantFaqDto extends UpdateAssistantFaqDto {
  @ApiPropertyOptional({
    description:
      'Si se ofrece como plantilla a las distribuidoras. Si no viene, queda como estaba.',
  })
  @IsOptional()
  @IsBoolean()
  useAsTemplate?: boolean;
}

export class AssistantFaqResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'medios_de_pago',
    description:
      'Clave de la plantilla de OrixTech de la que salió; nula si la escribió la distribuidora.',
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
  @ApiProperty({ example: 'medios_de_pago' }) key!: string;

  @ApiProperty({
    description: 'Si se ofrece como plantilla a las distribuidoras',
  })
  useAsTemplate!: boolean;
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
  @ApiProperty({ example: 5, description: 'Plantillas copiadas ahora' })
  copied!: number;

  @ApiProperty({
    example: 0,
    description:
      'Plantillas que no se copiaron porque la base ya tiene esa clave o esa misma pregunta',
  })
  skipped!: number;

  @ApiProperty({
    example: 4,
    description: 'Versión de la base después de copiar',
  })
  version!: number;
}
