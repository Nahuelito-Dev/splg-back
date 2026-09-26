import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AdminMapper } from './admin.mapper';
import { CreateAdminDto } from './dto/create-admin.dto';
import { BuscarAdminParamDto } from './dto/buscar-admin-param.dto';
import {
  AdminResponseDto,
  AdminVistaResponseDto,
} from './dto/admin-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post()
  @Auth(RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create admin (basic)' })
  @ApiCreatedResponse({ type: AdminResponseDto })
  @ApiBadRequestResponse({
    description:
      'Sólo un usuario con rol admin o super_admin tiene perfil de administrador · property role_id should not exist; user_id must be a UUID',
  })
  async create(
    @Body() createAdminDto: CreateAdminDto,
  ): Promise<AdminResponseDto> {
    return AdminMapper.toDto(await this.adminService.create(createAdminDto));
  }

  @Get('/term/:term')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Find admin by term (id o correo)' })
  @ApiOkResponse({ type: AdminVistaResponseDto })
  @ApiNotFoundResponse({ description: 'No hay un admin con ese id o correo' })
  async findOneByEmail(
    @Param() { term }: BuscarAdminParamDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<AdminVistaResponseDto> {
    return AdminMapper.toVista(
      await this.adminService.findAdminByTerm(term, distributorId),
    );
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all admins (scopeado por distribuidora)' })
  @ApiOkResponse({ type: AdminResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<AdminResponseDto[]> {
    const admins = await this.adminService.findAll(distributorId);
    return admins.map((a) => AdminMapper.toDto(a));
  }
}
