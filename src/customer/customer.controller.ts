import type { Response } from 'express';
import { ApiTotal, informarTotal } from '../common/http/total';
import {
  Controller,
  Get,
  Body,
  Patch,
  Param,
  Delete,
  Post,
  Query,
  Res,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
  ForbiddenException,
  Version,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { CustomersService } from './customer.service';
import { UpdateCustomerLocationDto } from './dto/update-customer-location.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerResponseDto } from './dto/customer-response.dto';
import { CustomerMapper } from './customer.mapper';
import { Customer } from './entities/customer.entity';
import { UserPhotoService } from '../users/user-photo.service';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { alcanceDelDueño, esAdministrador } from '../common/utils/alcance.util';
import { Permiso } from '../common/decorators/permiso.decorator';

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly userPhoto: UserPhotoService,
  ) {}

  /** El DTO del cliente con la foto de su usuario como URL firmada vigente. */
  private async aDto(customer: Customer): Promise<CustomerResponseDto> {
    await this.userPhoto.firmar(customer.user);
    return CustomerMapper.toDto(customer);
  }

  @Get()
  @Permiso('clientes.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Get customers (scopeado por distribuidora: solo los que pidieron a esa empresa)',
  })
  @ApiOkResponse({ type: CustomerResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Parámetros de paginación o filtros inválidos',
  })
  @ApiTotal()
  async findAll(
    @Query() paginationDto: QueryCustomersDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<CustomerResponseDto[]> {
    const [customers, total] = await this.customersService.findAll(
      paginationDto,
      distributorId,
    );
    informarTotal(res, total);
    await this.userPhoto.firmar(
      customers.flatMap((c) => (c.user ? [c.user] : [])),
    );
    return customers.map((c) => CustomerMapper.toDto(c));
  }

  @Get('removed')
  @Version('2')
  @Permiso('clientes.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Clientes que la distribuidora dio de baja (búsqueda por nombre o teléfono)',
  })
  @ApiOkResponse({ type: CustomerResponseDto, isArray: true })
  @ApiTotal()
  async findRemoved(
    @Query() paginationDto: QueryCustomersDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor({ required: 'staff' }) distributorId: string,
  ): Promise<CustomerResponseDto[]> {
    const [customers, total] = await this.customersService.findRemoved(
      paginationDto,
      distributorId,
    );
    informarTotal(res, total);
    await this.userPhoto.firmar(
      customers.flatMap((c) => (c.user ? [c.user] : [])),
    );
    return customers.map((c) => CustomerMapper.toDto(c));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get customer by ID' })
  @ApiForbiddenResponse({ description: 'Es de otro cliente' })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'Cliente no encontrado' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ customer_id: id }, user, distributorId);
    return this.aDto(
      await this.customersService.findOne(id, alcanceDelDueño(user)),
    );
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get customer by user ID' })
  @ApiForbiddenResponse({ description: 'Es de otro cliente' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiBadRequestResponse({ description: 'El id de usuario no es un UUID' })
  @ApiNotFoundResponse({ description: 'Cliente no encontrado' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOneByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ user_id: userId }, user, distributorId);
    return this.aDto(
      await this.customersService.findOneByUserId(
        userId,
        alcanceDelDueño(user),
      ),
    );
  }

  @Patch(':id')
  // Sólo restringe al personal (el `PermissionGuard` mira a los `admin`): el
  // cliente sigue editando lo suyo y el super admin pasa.
  @Permiso('clientes.gestionar')
  @ApiOperation({ summary: 'Update customer by ID' })
  @ApiForbiddenResponse({
    description:
      'Es de otro cliente; o es un administrador sin `clientes.gestionar` (`PERMISSION_DENIED`)',
  })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'Cliente no encontrado' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Se envió un dato que no corresponde: Usuario; Se envió un dato que no corresponde)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCustomerDto: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ customer_id: id }, user, distributorId);
    return this.aDto(
      await this.customersService.update(
        id,
        updateCustomerDto,
        alcanceDelDueño(user),
      ),
    );
  }

  @Patch(':id/location')
  @Permiso('clientes.gestionar')
  @ApiOperation({ summary: 'Update customer location' })
  @ApiForbiddenResponse({
    description:
      'Es de otro cliente; o es un administrador sin `clientes.gestionar` (`PERMISSION_DENIED`)',
  })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'Cliente no encontrado' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Coordenadas: tiene que ser "latitud,longitud", por ejemplo -27.3671,-55.8961)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerLocationDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ customer_id: id }, user, distributorId);
    return this.aDto(
      await this.customersService.updateLocation(
        id,
        dto.latLng,
        alcanceDelDueño(user),
      ),
    );
  }

  @Delete(':id')
  @Permiso('clientes.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete customer by ID (soft delete)' })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o falta la distribuidora',
  })
  @ApiNotFoundResponse({ description: 'Cliente no encontrado' })
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<MessageResponseDto> {
    await this.acotar({ customer_id: id }, user, distributorId);
    // Un cliente puede comprarle a varias distribuidoras: darlo de baja lo
    // saca de todas. Lo decide el administrador general, como en users.
    if (user.role === RoleType.ADMIN) {
      throw new ForbiddenException(
        'La cuenta de un cliente la administra el administrador general',
      );
    }
    return this.customersService.remove(id);
  }

  @Delete(':id/distributor')
  @Version('2')
  @Permiso('clientes.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Dar de baja al cliente en la distribuidora (no toca su cuenta ni sus pedidos)',
  })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o falta la distribuidora',
  })
  @ApiNotFoundResponse({
    description: 'El cliente no es de esa distribuidora',
  })
  @ApiConflictResponse({ description: 'Tiene pedidos en curso' })
  @HttpCode(HttpStatus.OK)
  async removeFromDistributor(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string,
  ): Promise<MessageResponseDto> {
    return this.customersService.darDeBajaEnDistribuidora(
      id,
      distributorId,
      user.user_id,
    );
  }

  @Post(':id/distributor')
  @Version('2')
  @Permiso('clientes.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Reactivar al cliente dado de baja en la distribuidora',
  })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o falta la distribuidora',
  })
  @ApiNotFoundResponse({
    description: 'No hay un cliente dado de baja con esa distribuidora',
  })
  @HttpCode(HttpStatus.OK)
  async restoreInDistributor(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: 'staff' }) distributorId: string,
  ): Promise<MessageResponseDto> {
    return this.customersService.reactivarEnDistribuidora(id, distributorId);
  }

  /**
   * Con distribuidora en contexto, un administrador sólo llega a los clientes
   * que le compraron a ella. El cliente mismo no se acota por distribuidora:
   * su ownership lo controla el servicio.
   */
  private async acotar(
    por: { customer_id: string } | { user_id: string },
    user: AuthenticatedUser,
    distributorId: string | null,
  ): Promise<void> {
    if (esAdministrador(user) && distributorId) {
      await this.customersService.assertDeLaDistribuidora(por, distributorId);
    }
  }
}
