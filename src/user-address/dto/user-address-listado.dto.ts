import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserAddressResponseDto } from './user-address-response.dto';
import { UserResponseDto } from '../../users/dto/user-response.dto';

/** La dirección con su usuario, cuando el endpoint lo carga. */
export class UserAddressConUsuarioDto extends UserAddressResponseDto {
  @ApiPropertyOptional({ type: UserResponseDto }) user?: UserResponseDto;
}

export class ListadoDeDireccionesDto {
  @ApiProperty({ type: UserAddressConUsuarioDto, isArray: true })
  addresses!: UserAddressConUsuarioDto[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}

export class DireccionBorradaDto {
  @ApiProperty({ example: 'Dirección dada de baja' }) message!: string;
  @ApiProperty({ format: 'uuid' }) addressId!: string;
}
