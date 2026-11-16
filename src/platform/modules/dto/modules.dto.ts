import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import { MODULOS, type ModuloKey } from '../catalogo-de-modulos';

const recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Cuerpo de `PUT /v2/platform/companies/:id/modules/:key`. */
export class SetCompanyModuleDto {
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'true: se habilita aunque el plan no lo traiga; false: se deshabilita aunque lo traiga; null: vuelve a lo que diga el plan. Obligatorio (null también se manda).',
  })
  @ValidateIf((o: { enabled?: unknown }) => o.enabled !== null)
  @IsBoolean()
  enabled!: boolean | null;

  @ApiProperty({
    minLength: 10,
    maxLength: 300,
    example: 'La empresa pidió probar el lector durante dos semanas',
    description:
      'Por qué la plataforma cambia el módulo. Queda en la fila y en la auditoría.',
  })
  @recortar()
  @IsString()
  @Length(10, 300)
  reason!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Hasta cuándo rige la excepción (ISO 8601, futura). Sin fecha, rige hasta que se cambie. No va con `enabled: null`.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}

export class CompanyModuleOverrideDto {
  @ApiProperty()
  enabled!: boolean;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: string | null;
}

export class CompanyModuleImpactDto {
  @ApiProperty({
    description:
      'Cuántas cosas del módulo quedan en curso (lecturas en cola, hojas sin terminar, invitaciones vigentes…)',
    example: 3,
  })
  pending!: number;

  @ApiProperty({
    example:
      '3 documentos esperando lectura. Los documentos que esperan lectura no se leen y quedan pendientes; subir documentos sigue funcionando.',
  })
  description!: string;
}

/** Un módulo de una empresa, como lo ve la plataforma. */
export class CompanyModuleDto {
  @ApiProperty({ enum: MODULOS, example: 'document_reading' })
  key!: ModuloKey;

  @ApiProperty({ example: 'Lector de documentos' })
  label!: string;

  @ApiProperty({ description: 'Lo trae el plan de la empresa (su foto)' })
  inPlan!: boolean;

  @ApiProperty({
    type: CompanyModuleOverrideDto,
    nullable: true,
    description:
      'La excepción vigente de la plataforma sobre el plan, o null si rige el plan',
  })
  override!: CompanyModuleOverrideDto | null;

  @ApiProperty({
    description:
      'Habilitado por la plataforma (excepción vigente o, si no hay, el plan)',
  })
  enabled!: boolean;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'El interruptor de la propia empresa (null: el módulo no tiene interruptor de la empresa)',
  })
  companySwitch!: boolean | null;

  @ApiProperty({
    description:
      'En uso de verdad: habilitado, encendido por la empresa y la empresa activa',
  })
  effective!: boolean;

  @ApiProperty({ type: CompanyModuleImpactDto })
  impact!: CompanyModuleImpactDto;
}

/** Un módulo como lo ve la propia empresa. */
export class OwnModuleDto {
  @ApiProperty({ enum: MODULOS, example: 'repurchase' })
  key!: ModuloKey;

  @ApiProperty({ example: 'Recompra anticipada' })
  label!: string;

  @ApiProperty({ description: 'La plataforma se lo habilitó a la empresa' })
  enabled!: boolean;

  @ApiProperty({ description: 'Habilitado y encendido por la empresa' })
  effective!: boolean;
}

export class FeaturesDto {
  @ApiProperty({
    enum: MODULOS,
    isArray: true,
    description: 'Los módulos en uso (habilitados y encendidos)',
    example: ['mercadopago', 'express'],
  })
  modules!: ModuloKey[];

  @ApiProperty({
    enum: ['full', 'warning', 'restricted', 'blocked'],
    description:
      'Nivel de acceso de la empresa: full (normal) o blocked (suspendida); warning y restricted llegan con los estados de la suscripción',
  })
  access!: 'full' | 'warning' | 'restricted' | 'blocked';
}

export class PublicFeaturesDto {
  @ApiProperty({
    enum: MODULOS,
    isArray: true,
    description: 'Los módulos en uso (habilitados y encendidos)',
    example: ['mercadopago', 'express'],
  })
  modules!: ModuloKey[];

  @ApiProperty({ description: 'Si la distribuidora toma pedidos hoy' })
  acceptingOrders!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Texto para mostrar cuando no toma pedidos',
  })
  message!: string | null;
}
