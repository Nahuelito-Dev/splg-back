import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  IsUrl,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateClaimDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  orderId!: string;

  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @ApiProperty()
  @TextoNoVacio()
  reason!: string;

  @ApiProperty()
  @TextoNoVacio()
  description!: string;

  @ApiProperty({
    required: false,
    deprecated: true,
    description:
      'Obsoleto: la foto se sube después con `POST /claims/:id/photo`. Se ' +
      'sigue aceptando por compatibilidad con las apps ya publicadas.',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  photoUrl?: string;
}
