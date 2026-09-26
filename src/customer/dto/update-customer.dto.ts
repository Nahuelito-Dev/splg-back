import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateCustomerDto } from './create-customer.dto';

/**
 * Lo que se puede modificar de un perfil de cliente. No incluye `user_id`: a
 * qué usuario pertenece un perfil no se cambia. `validated` lo acepta el DTO,
 * pero sólo un administrador puede mandarlo (lo controla el controlador).
 */
export class UpdateCustomerDto extends PartialType(
  OmitType(CreateCustomerDto, ['user_id'] as const),
) {}
