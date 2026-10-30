import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';

/** Tope de ids por pedido, para usuarios, legajos y choferes por separado. */
export const MAX_PERSONAS_POR_PEDIDO = 100;

export class PeoplePhotosRequestDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: MAX_PERSONAS_POR_PEDIDO,
    description: 'Ids de usuario (clientes, choferes, admins). Puede ir vacío.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_PERSONAS_POR_PEDIDO)
  @IsUUID('all', { each: true })
  userIds!: string[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_PERSONAS_POR_PEDIDO,
    description: 'Ids de legajo (empleados), con o sin cuenta de acceso.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PERSONAS_POR_PEDIDO)
  @IsUUID('all', { each: true })
  employeeIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_PERSONAS_POR_PEDIDO,
    description:
      'Ids de chofer (`delivery_id`): se resuelven a la foto de su usuario.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PERSONAS_POR_PEDIDO)
  @IsUUID('all', { each: true })
  deliveryIds?: string[];
}

export class PersonPhotoDto {
  @ApiProperty({
    description: 'URL firmada de S3 (se abre sin token).',
  })
  url!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}

@ApiExtraModels(PersonPhotoDto)
export class PeoplePhotosResponseDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      allOf: [{ $ref: getSchemaPath(PersonPhotoDto) }],
      nullable: true,
    },
    description:
      'Una entrada por cada id pedido. `null` si no tiene foto, no existe o no es de la distribuidora (no se distingue).',
  })
  users!: Record<string, PersonPhotoDto | null>;

  @ApiProperty({
    type: 'object',
    additionalProperties: {
      allOf: [{ $ref: getSchemaPath(PersonPhotoDto) }],
      nullable: true,
    },
    description:
      'Igual que `users`, por id de legajo. Si el legajo tiene cuenta, es la foto del usuario.',
  })
  employees!: Record<string, PersonPhotoDto | null>;

  @ApiProperty({
    type: 'object',
    additionalProperties: {
      allOf: [{ $ref: getSchemaPath(PersonPhotoDto) }],
      nullable: true,
    },
    description: 'Igual que `users`, por id de chofer (`delivery_id`).',
  })
  deliveries!: Record<string, PersonPhotoDto | null>;
}
