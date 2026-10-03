import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { RoleType } from '../../common/constants/role-type.enum';

/** `GET /users`: pagina, busca por `term` y filtra por `role`. */
export class QueryUsersDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: RoleType,
    description:
      'Filtra por tipo de rol, exacto: `admin` no incluye a `super_admin` ' +
      '(son dos valores distintos). Sin este parámetro devuelve todos. El ' +
      'total va en `maxUsers` y también en `X-Total-Count`.',
  })
  @IsOptional()
  @IsEnum(RoleType, {
    message: 'role debe ser admin, super_admin, customer o delivery',
  })
  role?: RoleType;
}
