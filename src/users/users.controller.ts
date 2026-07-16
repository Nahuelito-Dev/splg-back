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
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { CompleteCustomerRegistrationDto } from 'src/customer/dto/complete-customer-registration.dto';
import { CustomersService } from 'src/customer/customer.service';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RoleType } from 'src/common/constants/role-type.enum';
import { CreateDeliveryDto } from 'src/delivery/dto/create-delivery.dto';
import { DeliveryService } from 'src/delivery/delivery.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(AuthGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly customersService: CustomersService,
    private readonly deliveryService: DeliveryService,
  ) {}

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
    return await this.customersService.registerWithUser(
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
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId?: string | null,
  ) {
    // El chofer se asocia a una distribuidora. super_admin puede elegir (body o
    // "ver como"); un admin de empresa lo crea SIEMPRE en su propia empresa
    // (se ignora el distributorId del body).
    const targetDistributor =
      user.role === RoleType.SUPER_ADMIN
        ? (createDeliveryDto.distributorId ?? distributorId ?? undefined)
        : distributorId ?? undefined;

    if (user.role !== RoleType.SUPER_ADMIN && !targetDistributor) {
      throw new ForbiddenException(
        'Tu usuario no tiene una distribuidora asociada',
      );
    }

    return await this.deliveryService.registerWithUser({
      ...createDeliveryDto,
      distributorId: targetDistributor,
    });
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
  @ApiResponse({ status: 403, description: 'No autorizado a modificar este usuario' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const isAdmin =
      user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN;

    // Ownership: un no-admin SOLO puede modificarse a sí mismo. Antes cualquier
    // usuario autenticado podía editar a otro por id (IDOR).
    if (!isAdmin && id !== user.user_id) {
      throw new ForbiddenException('No podés modificar a otro usuario');
    }

    // Whitelist de campos para auto-edición: un no-admin solo puede tocar sus
    // datos de contacto. Campos sensibles (blocked, role_id, email, password,
    // flags de verificación, firebase_uid) quedan reservados a admin.
    const payload = isAdmin
      ? updateUserDto
      : this.pickSelfEditableFields(updateUserDto);

    return await this.usersService.update(id, payload);
  }

  /** Campos que un usuario puede cambiar de su propio perfil. */
  private pickSelfEditableFields(dto: UpdateUserDto): Partial<UpdateUserDto> {
    const allowed: Array<keyof UpdateUserDto> = [
      'full_name',
      'phone_number',
      'selfie',
    ];
    const result: Partial<UpdateUserDto> = {};
    for (const key of allowed) {
      if (dto[key] !== undefined) {
        (result as any)[key] = dto[key];
      }
    }
    return result;
  }

  @Delete(':id')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete user by ID (soft delete)' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return await this.usersService.remove(id);
  }

  @Patch(':id/block')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'ADMIN: Bloquear/Desbloquear usuario' })
  async blockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { block: boolean }, // Recibimos { "block": true } o false
  ) {
    return this.usersService.toggleBlockUser(id, body.block);
  }
}
