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
  HttpStatus,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { CompleteCustomerRegistrationDto } from 'src/customer/dto/complete-customer-registration.dto';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RoleType } from 'src/common/constants/role-type.enum';
import { CreateDeliveryDto } from 'src/delivery/dto/create-delivery.dto';
import { RolesGuard } from '../common/decorators/roles.guard';
import { AuthGuard } from 'src/auth/guards/jwt-auth.guard';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(AuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(@Body() createUserDto: CreateUserDto) {
    return await this.usersService.create(createUserDto);
  }

  @Public()
  @Get('email/:email')
  @ApiOperation({ summary: 'Get user by email' })
  @ApiParam({ name: 'email', description: 'User email' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOneByEmail(@Param('email') email: string) {
    return await this.usersService.findOneByEmail(email);
  }

  // users.controller.ts - AGREGAR ESTE ENDPOINT
  @Public()
  @Post('customer-registration')
  @ApiOperation({
    summary: 'Complete customer registration (User + Customer + Firebase)',
  })
  @ApiResponse({
    status: 201,
    description: 'Customer and user created successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async createCustomerRegistration(
    @Body() completeRegistrationDto: CompleteCustomerRegistrationDto,
  ) {
    return await this.usersService.createCustomerWithUser(
      completeRegistrationDto,
    );
  }

  @Post('delivery-registration')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Complete delivery registration (User + Delivery + Firebase) - Admin only',
  })
  @ApiResponse({
    status: 201,
    description: 'Delivery and user created successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  async createDeliveryRegistration(
    @Body() createDeliveryDto: CreateDeliveryDto,
  ) {
    return await this.usersService.createDeliveryWithUser(createDeliveryDto);
  }

  @Get()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all users with pagination and search' })
  async findAll(
    @Query() paginationDto: PaginationDto,
    @Query('term') term?: string, // <--- Agregamos esto
  ) {
    return await this.usersService.findAll({ ...paginationDto, term });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.usersService.findOne(id);
  }

  @Get('phone/:phoneNumber')
  @ApiOperation({ summary: 'Get user by phone number' })
  @ApiParam({ name: 'phoneNumber', description: 'User phone number' })
  @ApiResponse({ status: 200, description: 'User found' })
  async findOneByPhone(@Param('phoneNumber') phoneNumber: string) {
    return await this.usersService.findOneByPhone(phoneNumber);
  }

  @Public()
  @Post('check-exists')
  @ApiOperation({ summary: 'Check if user exists by email or phone' })
  @ApiResponse({ status: 200, description: 'Existence check result' })
  async checkUserExists(
    @Body() body: { email?: string; phoneNumber?: string },
  ) {
    return await this.usersService.checkUserExists(
      body.email,
      body.phoneNumber,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update user by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return await this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete user by ID (soft delete)' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return await this.usersService.remove(id);
  }

  @Patch(':id/block')
  @ApiOperation({ summary: 'ADMIN: Bloquear/Desbloquear usuario' })
  async blockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { block: boolean }, // Recibimos { "block": true } o false
  ) {
    return this.usersService.toggleBlockUser(id, body.block);
  }
}
