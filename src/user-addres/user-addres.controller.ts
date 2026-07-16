// src/user-addres/user-addres.controller.ts - CORREGIDO
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { UserAddresService } from './user-addres.service';
import { CreateUserAddresDto } from './dto/create-user-addres.dto'; // <- Nombre correcto
import { UpdateUserAddresDto } from './dto/update-user-addres.dto'; // <- Nombre correcto
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

/**
 * Ownership (anti-IDOR): un cliente/chofer solo accede a SUS propias direcciones;
 * los admin acceden a cualquiera. `scope()` devuelve el user_id del que pide si
 * NO es admin (fuerza el filtro por dueño), o undefined si es admin.
 */
function scope(user: AuthenticatedUser): string | undefined {
  return user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN
    ? undefined
    : user.user_id;
}

@ApiTags('User Addresses')
@Controller('user-address')
export class UserAddresController {
  constructor(private readonly userAddresService: UserAddresService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new user address' })
  @ApiResponse({ status: 201, description: 'Address created successfully' })
  create(
    @Body() createUserAddressDto: CreateUserAddresDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userAddresService.create(createUserAddressDto, scope(user));
  }

  @Get()
  @Roles(RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all user addresses (super_admin — listado global de soporte)',
  })
  @ApiResponse({ status: 200, description: 'List of addresses' })
  findAll(@Query() paginationDto: PaginationDto) {
    return this.userAddresService.findAll(paginationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address found' })
  @ApiResponse({ status: 404, description: 'Address not found' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userAddresService.findOne(id, scope(user));
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get addresses by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'List of user addresses' })
  findByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userAddresService.findByUserId(userId, scope(user));
  }

  @Get('user/:userId/default')
  @ApiOperation({ summary: 'Get default address for user' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'Default address found' })
  @ApiResponse({ status: 404, description: 'No default address found' })
  findDefaultByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userAddresService.findDefaultByUserId(userId, scope(user));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address updated successfully' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserAddressDto: UpdateUserAddresDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userAddresService.update(id, updateUserAddressDto, scope(user));
  }

  @Patch(':id/set-default')
  @ApiOperation({ summary: 'Set address as default' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address set as default' })
  setAsDefault(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userAddresService.setAsDefault(id, scope(user));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address deleted successfully' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.userAddresService.remove(id, scope(user));
  }
}
