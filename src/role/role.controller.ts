import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { RoleService } from './role.service';
import { RoleMapper } from './role.mapper';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleResponseDto } from './dto/role-response.dto';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';

@ApiTags('Role')
@ApiBearerAuth()
@Auth(RoleType.SUPER_ADMIN)
@Controller('role')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Post()
  @ApiOperation({ summary: 'Crear un rol' })
  @ApiCreatedResponse({ type: RoleResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos (p. ej.: Tipo: tiene que ser un texto)',
  })
  @ApiConflictResponse({ description: 'Ya existe un rol con ese nombre' })
  async create(@Body() createRoleDto: CreateRoleDto): Promise<RoleResponseDto> {
    return RoleMapper.toDto(await this.roleService.create(createRoleDto));
  }

  @Get()
  @ApiOperation({ summary: 'Listar los roles' })
  @ApiOkResponse({ type: RoleResponseDto, isArray: true })
  async findAll(): Promise<RoleResponseDto[]> {
    const roles = await this.roleService.findAll();
    return roles.map((role) => RoleMapper.toDto(role));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar un rol' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'El rol no existe' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RoleResponseDto> {
    return RoleMapper.toDto(await this.roleService.findOne(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Modificar un rol' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiNotFoundResponse({ description: 'El rol no existe' })
  @ApiConflictResponse({ description: 'Es un rol del sistema' })
  @ApiBadRequestResponse({
    description: 'Datos inválidos (p. ej.: Tipo: tiene que ser un texto)',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateRoleDto: UpdateRoleDto,
  ): Promise<RoleResponseDto> {
    return RoleMapper.toDto(await this.roleService.update(id, updateRoleDto));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Borrar un rol' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'El rol no existe' })
  @ApiConflictResponse({
    description: 'Es un rol del sistema, o todavía tiene usuarios',
  })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<MessageResponseDto> {
    return this.roleService.remove(id);
  }

  @Post('seed')
  @ApiOperation({ summary: 'Crear los roles del sistema que falten' })
  @ApiCreatedResponse({ type: MessageResponseDto })
  seedRoles(): Promise<MessageResponseDto> {
    return this.roleService.seedRoles();
  }
}
