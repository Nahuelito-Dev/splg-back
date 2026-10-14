import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  ForbiddenException,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserAddressService } from './user-address.service';
import { UserAddressMapper } from './user-address.mapper';
import { CreateUserAddressDto } from './dto/create-user-address.dto';
import { UpdateUserAddressDto } from './dto/update-user-address.dto';
import { UserAddressResponseDto } from './dto/user-address-response.dto';
import {
  DireccionBorradaDto,
  ListadoDeDireccionesDto,
  UserAddressConUsuarioDto,
} from './dto/user-address-listado.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { alcanceDelDueño, esAdministrador } from '../common/utils/alcance.util';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

/**
 * Propiedad del dato (anti-IDOR): un cliente o chofer sólo accede a SUS
 * direcciones; un administrador, a cualquiera (ver alcanceDelDueño).
 *
 * Aislamiento: el admin de una empresa sólo llega a las direcciones de sus
 * usuarios (lo ajeno = 404) y no las modifica: la cuenta de un cliente, que
 * puede comprarle a varias distribuidoras, la administra el administrador
 * general (403), igual que en users.
 */
@ApiTags('User Addresses')
@ApiBearerAuth()
@Controller('user-address')
export class UserAddressController {
  constructor(private readonly userAddressService: UserAddressService) {}

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Create a new user address' })
  @ApiCreatedResponse({ type: UserAddressResponseDto })
  @ApiNotFoundResponse({ description: 'El usuario no existe' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: user_id must be a UUID; street must be a string)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async create(
    @Body() createUserAddressDto: CreateUserAddressDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserAddressResponseDto> {
    if (esAdministrador(user)) {
      if (!createUserAddressDto.user_id) {
        throw new BadRequestException(
          'user_id: indicá el usuario dueño de la dirección',
        );
      }
      await this.acotar(
        { userId: createUserAddressDto.user_id },
        user,
        distributorId,
        true,
      );
    }
    return UserAddressMapper.toDto(
      await this.userAddressService.create(
        createUserAddressDto,
        alcanceDelDueño(user),
      ),
    );
  }

  @Get()
  @Auth(RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Listar todas las direcciones (paginado)' })
  @ApiOkResponse({ type: ListadoDeDireccionesDto })
  async findAll(
    @Query() paginationDto: PaginationDto,
  ): Promise<ListadoDeDireccionesDto> {
    const r = await this.userAddressService.findAll(paginationDto);
    return {
      ...r,
      addresses: r.addresses.map((a) => UserAddressMapper.toDtoConUsuario(a)),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiOkResponse({ type: UserAddressConUsuarioDto })
  @ApiNotFoundResponse({ description: 'Address not found' })
  @ApiForbiddenResponse({ description: 'Es de otro usuario' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserAddressConUsuarioDto> {
    await this.acotar({ addressId: id }, user, distributorId, false);
    return UserAddressMapper.toDtoConUsuario(
      await this.userAddressService.findOne(id, alcanceDelDueño(user)),
    );
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get addresses by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiOkResponse({ type: UserAddressConUsuarioDto, isArray: true })
  @ApiForbiddenResponse({ description: 'Son de otro usuario' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  @ApiNotFoundResponse({ description: 'Dirección no encontrada' })
  async findByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserAddressConUsuarioDto[]> {
    await this.acotar({ userId }, user, distributorId, false);
    const addresses = await this.userAddressService.findByUserId(
      userId,
      alcanceDelDueño(user),
    );
    return addresses.map((a) => UserAddressMapper.toDtoConUsuario(a));
  }

  @Get('user/:userId/default')
  @ApiOperation({ summary: 'Get default address for user' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiOkResponse({ type: UserAddressConUsuarioDto })
  @ApiNotFoundResponse({ description: 'No default address found' })
  @ApiForbiddenResponse({ description: 'Es de otro usuario' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findDefaultByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserAddressConUsuarioDto> {
    await this.acotar({ userId }, user, distributorId, false);
    return UserAddressMapper.toDtoConUsuario(
      await this.userAddressService.findDefaultByUserId(
        userId,
        alcanceDelDueño(user),
      ),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiOkResponse({ type: UserAddressResponseDto })
  @ApiNotFoundResponse({ description: 'Address not found' })
  @ApiForbiddenResponse({ description: 'Es de otro usuario' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: latitude debe ser una latitud válida; longitude debe ser una longitud válida)',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserAddressDto: UpdateUserAddressDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserAddressResponseDto> {
    await this.acotar({ addressId: id }, user, distributorId, true);
    return UserAddressMapper.toDto(
      await this.userAddressService.update(
        id,
        updateUserAddressDto,
        alcanceDelDueño(user),
      ),
    );
  }

  @Patch(':id/set-default')
  @ApiOperation({ summary: 'Set address as default' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiOkResponse({ type: UserAddressConUsuarioDto })
  @ApiNotFoundResponse({ description: 'Address not found' })
  @ApiForbiddenResponse({ description: 'Es de otro usuario' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async setAsDefault(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<UserAddressConUsuarioDto> {
    await this.acotar({ addressId: id }, user, distributorId, true);
    return UserAddressMapper.toDtoConUsuario(
      await this.userAddressService.setAsDefault(id, alcanceDelDueño(user)),
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete address by ID' })
  @ApiParam({ name: 'id', description: 'Address UUID' })
  @ApiOkResponse({ type: DireccionBorradaDto })
  @ApiNotFoundResponse({ description: 'Address not found' })
  @ApiForbiddenResponse({ description: 'Es de otro usuario' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DireccionBorradaDto> {
    await this.acotar({ addressId: id }, user, distributorId, true);
    return this.userAddressService.remove(id, alcanceDelDueño(user));
  }

  private async acotar(
    ref: { userId: string } | { addressId: string },
    user: AuthenticatedUser,
    distributorId: string | null,
    escribe: boolean,
  ): Promise<void> {
    if (!esAdministrador(user) || !distributorId) return;
    await this.userAddressService.assertDeLaDistribuidora(ref, distributorId);
    if (escribe && user.role === RoleType.ADMIN) {
      throw new ForbiddenException(
        'Las direcciones de un usuario las administra el administrador general',
      );
    }
  }
}
