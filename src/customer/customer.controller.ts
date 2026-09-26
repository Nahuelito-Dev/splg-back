import {
  Controller,
  Get,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
  ForbiddenException,
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
} from '@nestjs/swagger';
import { CustomersService } from './customer.service';
import { UpdateCustomerLocationDto } from './dto/update-customer-location.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerResponseDto } from './dto/customer-response.dto';
import { CustomerMapper } from './customer.mapper';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { alcanceDelDueño, esAdministrador } from '../common/utils/alcance.util';

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Get customers (scopeado por distribuidora: solo los que pidieron a esa empresa)',
  })
  @ApiOkResponse({ type: CustomerResponseDto, isArray: true })
  async findAll(
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<CustomerResponseDto[]> {
    const customers = await this.customersService.findAll(
      paginationDto,
      distributorId,
    );
    return customers.map((c) => CustomerMapper.toDto(c));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get customer by ID' })
  @ApiForbiddenResponse({ description: 'Es de otro cliente' })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ customer_id: id }, user, distributorId);
    return CustomerMapper.toDto(
      await this.customersService.findOne(id, alcanceDelDueño(user)),
    );
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get customer by user ID' })
  @ApiForbiddenResponse({ description: 'Es de otro cliente' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOneByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ user_id: userId }, user, distributorId);
    return CustomerMapper.toDto(
      await this.customersService.findOneByUserId(
        userId,
        alcanceDelDueño(user),
      ),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update customer by ID' })
  @ApiForbiddenResponse({
    description:
      'Es de otro cliente, o un cliente intenta cambiar su validación',
  })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: property user_id should not exist; property campo_inventado should not exist)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCustomerDto: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ customer_id: id }, user, distributorId);
    return CustomerMapper.toDto(
      await this.customersService.update(
        id,
        updateCustomerDto,
        alcanceDelDueño(user),
      ),
    );
  }

  @Patch(':id/location')
  @ApiOperation({ summary: 'Update customer location' })
  @ApiForbiddenResponse({ description: 'Es de otro cliente' })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: latLng debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerLocationDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CustomerResponseDto> {
    await this.acotar({ customer_id: id }, user, distributorId);
    return CustomerMapper.toDto(
      await this.customersService.updateLocation(
        id,
        dto.latLng,
        alcanceDelDueño(user),
      ),
    );
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete customer by ID (soft delete)' })
  @ApiParam({ name: 'id', description: 'Customer UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({ description: 'Customer not found' })
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
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
