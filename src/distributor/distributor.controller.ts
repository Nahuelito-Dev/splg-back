import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
  NotFoundException,
  Put,
  Query,
  Res,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { DistributorMapper } from './distributor.mapper';
import { DistributorResponseDto } from './dto/distributor-response.dto';
import { DistributorService } from './distributor.service';
import { DistributorLogoService } from './distributor-logo.service';
import { Distributor } from './entities/distributor.entity';
import { CreateDistributorDto } from './dto/create-distributor.dto';
import { UpdateDistributorDto } from './dto/update-distributor.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { DownloadQueryDto } from '../s3/dto/download-link.dto';
import {
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../s3/photo-http';

/**
 * Gestión de distribuidoras (tenants). Es una operación de PLATAFORMA:
 * sólo el super_admin puede crear/editar/borrar tenants. Un admin de
 * distribuidora nunca administra otras distribuidoras.
 */
@ApiTags('Distributors')
@ApiBearerAuth()
@Auth(RoleType.SUPER_ADMIN)
@Controller('distributor')
export class DistributorController {
  constructor(
    private readonly distributorService: DistributorService,
    private readonly logo: DistributorLogoService,
  ) {}

  /** El DTO con `photoUrl` firmada si hay logo en S3. */
  private async toDto(d: Distributor): Promise<DistributorResponseDto> {
    await this.logo.firmar(d);
    return DistributorMapper.toDto(d);
  }

  /** Un admin queda acotado a su distribuidora; el super admin no. */
  private alcance(user: AuthenticatedUser, distributorId: string | null) {
    return user.role === RoleType.SUPER_ADMIN ? null : distributorId;
  }

  @Post()
  @ApiOperation({ summary: 'Crear una distribuidora (tenant)' })
  @ApiCreatedResponse({ type: DistributorResponseDto })
  @ApiConflictResponse({ description: 'slug duplicado' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Nombre: tiene que tener al menos 2 caracteres; Identificador de la distribuidora: tiene que tener sólo minúsculas, números y guiones (ej: demo))',
  })
  async create(
    @Body() dto: CreateDistributorDto,
  ): Promise<DistributorResponseDto> {
    return this.toDto(await this.distributorService.create(dto));
  }

  @Get()
  @ApiOperation({ summary: 'Listar todas las distribuidoras' })
  @ApiOkResponse({ type: DistributorResponseDto, isArray: true })
  async findAll(): Promise<DistributorResponseDto[]> {
    const all = await this.distributorService.findAll();
    await this.logo.firmar(all);
    return all.map((d) => DistributorMapper.toDto(d));
  }

  @Get('current')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'La distribuidora de la sesión',
    description:
      'Un admin recibe la suya; el super admin, la que eligió con ' +
      'X-Distributor. Sin distribuidora elegida contesta 404.',
  })
  @ApiOkResponse({ type: DistributorResponseDto })
  @ApiNotFoundResponse({ description: 'No hay una distribuidora elegida' })
  async findCurrent(
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DistributorResponseDto> {
    if (!distributorId) {
      throw new NotFoundException('No hay una distribuidora elegida');
    }
    return this.toDto(await this.distributorService.findOne(distributorId));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener distribuidora por ID' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ type: DistributorResponseDto })
  @ApiNotFoundResponse({ description: 'La distribuidora no existe' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DistributorResponseDto> {
    return this.toDto(await this.distributorService.findOne(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar distribuidora' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ type: DistributorResponseDto })
  @ApiNotFoundResponse({ description: 'La distribuidora no existe' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Se envió un dato que no corresponde: Identificador de la distribuidora)',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDistributorDto,
  ): Promise<DistributorResponseDto> {
    return this.toDto(await this.distributorService.update(id, dto));
  }

  @Put(':id/logo')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiSubirFoto(
    'Subir o reemplazar el logo de la distribuidora',
    DistributorResponseDto,
    'Un admin sólo el de su distribuidora; el super admin, el de cualquiera. ' +
      'El logo sale en `photoUrl` (URL firmada).',
  )
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @SubirFotoInterceptor()
  async uploadLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DistributorResponseDto> {
    return DistributorMapper.toDto(
      await this.logo.subir(id, this.alcance(user, distributorId), file),
    );
  }

  @Delete(':id/logo')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Sacar el logo de la distribuidora',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano) y ' +
      '`photoUrl` queda en null. No da de baja la distribuidora.',
  })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ type: DistributorResponseDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async removeLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DistributorResponseDto> {
    return DistributorMapper.toDto(
      await this.logo.quitar(id, this.alcance(user, distributorId)),
    );
  }

  @Get(':id/logo')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiVerFoto('Ver el logo de la distribuidora')
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  async getLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(
      res,
      query.modo,
      await this.logo.enlace(id, this.alcance(user, distributorId)),
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar (soft) distribuidora' })
  @ApiParam({ name: 'id', description: 'Distributor UUID' })
  @ApiOkResponse({ description: 'Sin cuerpo' })
  @ApiNotFoundResponse({ description: 'La distribuidora no existe' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.distributorService.remove(id);
  }
}
