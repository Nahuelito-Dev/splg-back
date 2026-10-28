import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminNotificationLinkDto {
  @ApiProperty({
    example: 'order',
    description:
      'Tipo de entidad a la que lleva el aviso (`order`, `claim`...)',
  })
  entity!: string;

  @ApiProperty({ example: '3f1c5a52-6a3e-4d6c-9a0e-2f7b6a1d9c11' })
  id!: string;
}

export class AdminNotificationResponseDto {
  @ApiProperty({ example: '9d8e7f60-1b2c-4d3e-8f4a-5b6c7d8e9f01' })
  id!: string;

  @ApiProperty({ example: 'claim_created', description: 'Tipo de aviso' })
  kind!: string;

  @ApiProperty({ example: 'Nuevo reclamo' })
  title!: string;

  @ApiProperty({ example: 'Pedido #ABC123: Garrafa con pérdida de gas' })
  body!: string;

  @ApiProperty({
    type: AdminNotificationLinkDto,
    nullable: true,
    description: 'A dónde lleva el aviso; `null` si no apunta a nada',
  })
  link!: AdminNotificationLinkDto | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'Cuándo lo leyó quien consulta; `null` si todavía no',
  })
  readAt!: Date | null;
}

/** Lo que llega al panel por el socket (`admin:notification`): el aviso más su empresa, para que el super admin filtre. */
export class AdminNotificationLiveDto extends AdminNotificationResponseDto {
  @ApiPropertyOptional({ format: 'uuid' })
  distributorId!: string;
}

export class AdminNotificationListResponseDto {
  @ApiProperty({ type: [AdminNotificationResponseDto] })
  items!: AdminNotificationResponseDto[];

  @ApiProperty({ example: 42, description: 'Total con el filtro aplicado' })
  total!: number;
}

export class UnreadCountResponseDto {
  @ApiProperty({ example: 3 })
  count!: number;
}

export class ReadAllResponseDto {
  @ApiProperty({
    example: 3,
    description: 'Cuántos avisos se marcaron como leídos',
  })
  updated!: number;
}
