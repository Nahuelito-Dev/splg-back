import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const FORMATO_HEX = /^#[0-9A-F]{6}$/;

/** `#d9530e` y `#D9530E` son el mismo color: se guarda en mayúsculas. */
const aMayusculas = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Un texto vacío o sólo espacios en el nombre es «sin nombre propio». */
const nombreONulo = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const recortado = value.trim().replace(/\s+/g, ' ');
  return recortado === '' ? null : recortado;
};

/** Cuerpo de `PUT /v2/company/theme` y de `POST /v2/company/theme/preview`. */
export class CompanyThemeDto {
  @ApiProperty({
    description:
      'Color principal en `#RRGGBB` (se acepta en minúsculas y se guarda en mayúsculas). Tiene que contrastar 4,5:1 con el texto de los botones (blanco o tinta, el que cumpla) y 3:1 con el blanco y el fondo del panel',
    example: '#1D4ED8',
    pattern: '^#[0-9A-Fa-f]{6}$',
  })
  @Transform(aMayusculas)
  @IsString()
  @Matches(FORMATO_HEX, {
    message: 'primaryColor: tiene que ser un color #RRGGBB',
  })
  primaryColor!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Color de acento en `#RRGGBB`; sin valor se deriva del principal. Tiene que contrastar 3:1 con el blanco y el fondo del panel',
    example: '#B27A00',
    pattern: '^#[0-9A-Fa-f]{6}$',
  })
  @IsOptional()
  @Transform(aMayusculas)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(FORMATO_HEX, {
    message: 'accentColor: tiene que ser un color #RRGGBB',
  })
  accentColor?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 2,
    maxLength: 60,
    description:
      'Nombre que se muestra en el encabezado del panel; sin valor (o vacío), el nombre de la distribuidora',
    example: 'Nahuel Gas',
  })
  @IsOptional()
  @Transform(nombreONulo)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[^<>]*$/, {
    message: 'El nombre para mostrar no puede tener los signos < ni >',
  })
  displayName?: string | null;
}

export class ThemeModeTokensDto {
  @ApiProperty({ example: '#1D4ED8' }) primary!: string;
  @ApiProperty({ example: '#103DC7' }) primaryHover!: string;
  @ApiProperty({ example: '#0832BC' }) primaryStrong!: string;
  @ApiProperty({ example: '#F0F5FF' }) primarySoft!: string;
  @ApiProperty({ example: '#FFFFFF', description: 'Blanco o tinta (#0B1220)' })
  onPrimary!: string;
  @ApiProperty({ example: '#956CD7' }) accent!: string;
  @ApiProperty({ example: '#F6F3FF' }) accentSoft!: string;
  @ApiProperty({ example: '#1D4ED8' }) gradientFrom!: string;
  @ApiProperty({ example: '#0D39C3' }) gradientTo!: string;
  @ApiProperty({ example: '#052AB6' }) gradientEdge!: string;
}

export class ThemeTokensDto {
  @ApiProperty({ type: ThemeModeTokensDto })
  light!: ThemeModeTokensDto;

  @ApiProperty({ type: ThemeModeTokensDto })
  dark!: ThemeModeTokensDto;
}

export class ThemeContrastDto {
  @ApiProperty({
    example: 'onPrimary/primary',
    description: 'Par medido: `<frente>/<fondo>` con los nombres de los roles',
  })
  pair!: string;

  @ApiProperty({ enum: ['light', 'dark'] })
  mode!: 'light' | 'dark';

  @ApiProperty({ example: 6.7, description: 'Relación medida (x:1)' })
  ratio!: number;

  @ApiProperty({ example: 4.5, description: 'Mínimo de WCAG AA para el par' })
  required!: number;

  @ApiProperty()
  ok!: boolean;
}

/** El tema de una empresa, guardado o calculado (vista previa y por omisión). */
export class CompanyThemeResponseDto {
  @ApiProperty({ example: '#1D4ED8' })
  primaryColor!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'El acento elegido, o null si se deriva del principal',
  })
  accentColor!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'El nombre para mostrar elegido, o null si no hay',
  })
  displayName!: string | null;

  @ApiProperty({
    example: 'Distribuidora Demo',
    description:
      'El nombre de la distribuidora (el que se muestra si no hay `displayName`)',
  })
  companyName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Logo de la distribuidora: URL firmada de corta vigencia, o null si no subió. Se cambia con `PUT /distributor/{id}/logo`',
  })
  logoUrl!: string | null;

  @ApiProperty({ type: ThemeTokensDto })
  tokens!: ThemeTokensDto;

  @ApiProperty({ type: [ThemeContrastDto] })
  contrast!: ThemeContrastDto[];

  @ApiProperty({
    example: 3,
    description:
      'Sube en cada cambio (también al restablecer); 0 si la empresa nunca configuró su tema. Sirve para saber si lo guardado sigue vigente',
  })
  version!: number;

  @ApiProperty({
    description:
      'true si la empresa usa el tema por omisión (nunca lo configuró o lo restableció)',
  })
  isDefault!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
  })
  updatedAt!: string | null;
}

/** Cuerpo del 400 `THEME_CONTRAST_INSUFFICIENT` (para Swagger). */
export class ThemeContrastErrorDto {
  @ApiProperty({ example: 400 }) statusCode!: number;
  @ApiProperty({
    example:
      'El color principal no contrasta lo suficiente con el blanco (1,54:1; hace falta 3:1). Probá con #B48700',
  })
  message!: string;
  @ApiProperty({ example: 'Solicitud inválida' }) error!: string;
  @ApiProperty({ example: 'THEME_CONTRAST_INSUFFICIENT' }) code!: string;
  @ApiProperty({ enum: ['primaryColor', 'accentColor'] }) field!: string;
  @ApiProperty({ example: 'primary/surface' }) pair!: string;
  @ApiProperty({ example: 1.54 }) ratio!: number;
  @ApiProperty({ example: 3 }) required!: number;
  @ApiProperty({
    example: '#B48700',
    description: 'El mismo tono con la luminosidad corregida, que sí cumple',
  })
  suggestion!: string;
}
