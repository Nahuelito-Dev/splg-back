import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateUserAddressDto } from './create-user-address.dto';

/**
 * Lo que se puede cambiar de una dirección. No incluye `user_id`: de quién es
 * una dirección no se cambia (H-60). Mandarlo da 400.
 */
export class UpdateUserAddressDto extends PartialType(
  OmitType(CreateUserAddressDto, ['user_id'] as const),
) {}
