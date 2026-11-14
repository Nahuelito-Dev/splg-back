import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  registerDecorator,
  type ValidationArguments,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { WarehouseKind } from '../domain/stock.enums';
import { StockBalanceDto } from './stock-response.dto';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateWarehouseDto {
  @ApiProperty({ example: 'Depósito central', maxLength: 80 })
  @TextoNoVacio()
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    example: 'CENTRAL',
    description:
      'Código corto, único entre los depósitos vigentes. Se guarda en mayúsculas.',
    maxLength: 12,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9_-]{1,12}$/, {
    message: 'code: hasta 12 letras, dígitos, guion o guion bajo',
  })
  code!: string;

  @ApiPropertyOptional({ enum: WarehouseKind, default: WarehouseKind.DEPOT })
  @IsOptional()
  @IsEnum(WarehouseKind)
  kind?: WarehouseKind;

  @ApiPropertyOptional({ example: 'Av. Siempreviva 742' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({
    description:
      'Lo deja como predeterminado (el que usa la entrega cuando el camión no tiene stock). El primero que se crea lo es siempre.',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateWarehouseDto extends PartialType(
  OmitType(CreateWarehouseDto, ['kind'] as const),
) {
  @ApiPropertyOptional({
    enum: WarehouseKind,
    description: 'Sólo cambia si se envía; si falta, conserva el tipo actual',
  })
  @IsOptional()
  @IsEnum(WarehouseKind)
  kind?: WarehouseKind;

  @ApiPropertyOptional({
    description:
      'false lo deja fuera de las listas de operación; no se puede con el predeterminado',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  isActive?: boolean;
}

type Clase = 'ausente' | 'nula' | 'numero' | 'otra';

const claseDe = (v: unknown): Clase =>
  v === undefined
    ? 'ausente'
    : v === null
      ? 'nula'
      : typeof v === 'number'
        ? 'numero'
        : 'otra';

interface OpcionesDeCoordenada {
  /** La otra coordenada de la pareja (`longitude` para `latitude`). */
  pareja: 'latitude' | 'longitude';
  /** Cómo se nombra la pareja en el mensaje («la longitud»). */
  nombrePareja: string;
  tope: number;
  /** Las dos en null borran la ubicación: sólo en la edición. */
  nulas: boolean;
}

/** El motivo por el que la coordenada no vale, o null si vale. */
function motivoDeCoordenada(
  valor: unknown,
  objeto: object,
  o: OpcionesDeCoordenada,
): string | null {
  const propia = claseDe(valor);
  const otra = claseDe((objeto as Record<string, unknown>)[o.pareja]);
  if (propia === 'ausente' && otra === 'ausente') return null;
  if (propia === 'otra') return 'tiene que ser un número';
  // Con número propio, el error es de la pareja (la que falta o vino vacía).
  const presenteOtra = otra === 'otra' ? 'numero' : otra;
  if (propia !== 'numero' && propia !== presenteOtra) {
    return `va junto con ${o.nombrePareja} (mandá las dos o ninguna)`;
  }
  if (propia === 'nula') {
    return o.nulas
      ? null
      : 'no puede ir vacía (mandá un número o no la mandes)';
  }
  const n = valor as number;
  if (!Number.isFinite(n) || Math.abs(n) > o.tope) {
    return `tiene que estar entre -${o.tope} y ${o.tope}`;
  }
  return null;
}

/**
 * Una coordenada del depósito: las dos con número, las dos en null (sólo en
 * la edición, para borrarla) o ninguna. Cada campo da su propio motivo.
 */
function CoordenadaDelDeposito(o: OpcionesDeCoordenada): PropertyDecorator {
  return (target: object, propiedad: string | symbol) => {
    registerDecorator({
      name: 'coordenadaDelDeposito',
      target: target.constructor,
      propertyName: String(propiedad),
      validator: {
        validate: (valor: unknown, args: ValidationArguments) =>
          motivoDeCoordenada(valor, args.object, o) === null,
        defaultMessage: (args?: ValidationArguments) =>
          (args && motivoDeCoordenada(args.value, args.object, o)) ??
          'no es válida',
      },
    });
  };
}

const LATITUD = {
  pareja: 'longitude',
  nombrePareja: 'la longitud',
  tope: 90,
} as const;
const LONGITUD = {
  pareja: 'latitude',
  nombrePareja: 'la latitud',
  tope: 180,
} as const;

/** Ubicación del depósito en el alta (v2): las dos coordenadas o ninguna. */
export class UbicacionAltaDto {
  @ApiPropertyOptional({
    type: Number,
    example: -27.3671,
    minimum: -90,
    maximum: 90,
    description: 'Latitud del depósito (WGS 84). Va junto con `longitude`.',
  })
  @CoordenadaDelDeposito({ ...LATITUD, nulas: false })
  latitude?: number;

  @ApiPropertyOptional({
    type: Number,
    example: -55.8961,
    minimum: -180,
    maximum: 180,
    description: 'Longitud del depósito (WGS 84). Va junto con `latitude`.',
  })
  @CoordenadaDelDeposito({ ...LONGITUD, nulas: false })
  longitude?: number;
}

/**
 * Ubicación del depósito en la edición (v2): las dos coordenadas, las dos en
 * null (borra la ubicación) o ninguna (no se toca).
 */
export class UbicacionEdicionDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: -27.3671,
    minimum: -90,
    maximum: 90,
    description:
      'Latitud del depósito (WGS 84). Va junto con `longitude`; las dos en null borran la ubicación.',
  })
  @CoordenadaDelDeposito({ ...LATITUD, nulas: true })
  latitude?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: -55.8961,
    minimum: -180,
    maximum: 180,
    description:
      'Longitud del depósito (WGS 84). Va junto con `latitude`; las dos en null borran la ubicación.',
  })
  @CoordenadaDelDeposito({ ...LONGITUD, nulas: true })
  longitude?: number | null;
}

/** Lo que el servicio recibe de la ubicación (alta o edición). */
export interface UbicacionDeDepositoDto {
  latitude?: number | null;
  longitude?: number | null;
}

/** Alta de un depósito con su ubicación (v2). */
export class CreateWarehouseV2Dto extends IntersectionType(
  CreateWarehouseDto,
  UbicacionAltaDto,
) {}

/** Edición de un depósito con su ubicación (v2). */
export class UpdateWarehouseV2Dto extends IntersectionType(
  UpdateWarehouseDto,
  UbicacionEdicionDto,
) {}

export class QueryWarehouseDto {
  @ApiPropertyOptional({
    description:
      'true incluye los depósitos inactivos (default: sólo los activos)',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  includeInactive?: boolean;
}

export class WarehouseResponseDto {
  @ApiProperty({ format: 'uuid' }) warehouseId!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'Ubicación de stock del depósito',
  })
  locationId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: WarehouseKind }) kind!: WarehouseKind;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class WarehouseDetailDto extends WarehouseResponseDto {
  @ApiProperty({
    type: () => StockBalanceDto,
    isArray: true,
    description: 'Saldos del depósito (sólo los positivos)',
  })
  balances!: StockBalanceDto[];
}

/** Depósito con su ubicación (v2). */
export class WarehouseV2ResponseDto extends WarehouseResponseDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: -27.3671,
    description:
      'Latitud del depósito; null si no está ubicado (la hoja de ruta avisa `no_warehouse`)',
  })
  latitude!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: -55.8961,
    description: 'Longitud del depósito; null si no está ubicado',
  })
  longitude!: number | null;
}

export class WarehouseV2DetailDto extends WarehouseV2ResponseDto {
  @ApiProperty({
    type: () => StockBalanceDto,
    isArray: true,
    description: 'Saldos del depósito (sólo los positivos)',
  })
  balances!: StockBalanceDto[];
}
