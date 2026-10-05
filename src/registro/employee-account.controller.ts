import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { GrantEmployeeAccountUseCase } from './grant-employee-account.use-case';
import { GrantEmployeeAccountDto } from '../employee/dto/grant-account.dto';
import { EmployeeResponseDto } from '../employee/dto/employee-response.dto';
import { EmployeeMapper } from '../employee/employee.mapper';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/** `POST /employees/:id/account`: vive acá porque delega en el alta de usuarios (CU-182). */
@ApiTags('Personal · Empleados')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('employees')
export class EmployeeAccountController {
  constructor(private readonly grant: GrantEmployeeAccountUseCase) {}

  @Post(':id/account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Otorgar una cuenta de acceso a un empleado, con el rol que le corresponde a su puesto (CU-182)',
    description:
      'Sólo los empleados de categoría driver tienen cuenta (rol chofer, con su perfil de reparto). ' +
      'Cualquier otra categoría responde 400.',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiBadRequestResponse({
    description:
      'La categoría del puesto no admite cuenta, o falta un teléfono válido',
  })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiConflictResponse({
    description:
      'Ya tiene cuenta, está egresado, o el correo/teléfono ya están en uso',
  })
  async grantAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GrantEmployeeAccountDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() usuario: AuthenticatedUser,
  ): Promise<EmployeeResponseDto> {
    const { empleado, deliveryId } = await this.grant.execute(
      id,
      dto,
      distributorId,
      { tipo: 'usuario', usuario },
    );
    return EmployeeMapper.toDto(empleado, deliveryId);
  }
}
