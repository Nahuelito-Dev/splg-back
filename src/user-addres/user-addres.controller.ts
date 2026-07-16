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

@ApiTags('User Addresses')
@Controller('user-address')
export class UserAddresController {
  constructor(private readonly userAddresService: UserAddresService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new user address' })
  @ApiResponse({ status: 201, description: 'Address created successfully' })
  create(@Body() createUserAddressDto: CreateUserAddresDto) {
    return this.userAddresService.create(createUserAddressDto);
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
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.userAddresService.findOne(id); // <- Cambiar: usar string, no +id
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get addresses by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'List of user addresses' })
  findByUserId(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.userAddresService.findByUserId(userId);
  }

  @Get('user/:userId/default')
  @ApiOperation({ summary: 'Get default address for user' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'Default address found' })
  @ApiResponse({ status: 404, description: 'No default address found' })
  findDefaultByUserId(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.userAddresService.findDefaultByUserId(userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address updated successfully' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserAddressDto: UpdateUserAddresDto,
  ) {
    return this.userAddresService.update(id, updateUserAddressDto);
  }

  @Patch(':id/set-default')
  @ApiOperation({ summary: 'Set address as default' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address set as default' })
  setAsDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.userAddresService.setAsDefault(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiResponse({ status: 200, description: 'Address deleted successfully' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.userAddresService.remove(id); // <- Cambiar: usar string, no +id
  }
}
