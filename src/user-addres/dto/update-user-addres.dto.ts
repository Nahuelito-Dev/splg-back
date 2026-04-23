import { PartialType } from '@nestjs/swagger';
import { CreateUserAddresDto } from './create-user-addres.dto';

export class UpdateUserAddresDto extends PartialType(CreateUserAddresDto) {}
