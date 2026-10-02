import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AdminMapper } from './admin.mapper';
import { CreateAdminDto } from './dto/create-admin.dto';
import { BuscarAdminParamDto } from './dto/buscar-admin-param.dto';
import { ListarAdminsQueryDto } from './dto/listar-admins-query.dto';
import {
  AdminResponseDto,
  AdminVistaResponseDto,
} from './dto/admin-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

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
  @ApiOperation({
    summary: 'Get all admins (scopeado por distribuidora)',
    description:
      'Un admin de empresa ve los de la suya. El super admin ve los de la ' +
      'distribuidora que elija con `?distributorId=` (aunque esté "viendo ' +
      'como" otra), o los de la distribuidora en contexto, o todos si no hay.',
  })
  @ApiOkResponse({ type: AdminResponseDto, isArray: true })
  @ApiBadRequestResponse({ description: 'distributorId no es un UUID' })
  @ApiForbiddenResponse({
    description:
      'Un admin de empresa pidió los admins de otra distribuidora (`distributorId`)',
  })
  async findAll(
    @Query() { distributorId: pedida }: ListarAdminsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() contexto: string | null,
  ): Promise<AdminResponseDto[]> {
    let distributorId = contexto;
    if (user.role === RoleType.SUPER_ADMIN) {
      distributorId = pedida ?? contexto;
    } else if (pedida && pedida !== contexto) {
      throw new ForbiddenException(
        'No podés ver los administradores de otra distribuidora',
      );
    }
    const admins = await this.adminService.findAll(distributorId);
    return admins.map((a) => AdminMapper.toDto(a));
  }
}
