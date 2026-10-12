import { IsNotEmpty, IsUUID } from 'class-validator';
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
}
