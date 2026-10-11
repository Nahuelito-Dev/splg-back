import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Delete,
  Query,
  Res,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiBadRequestResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { IncidentService } from './incident.service';
import { IncidentPhotoService } from './incident-photo.service';
import { Incident } from './entities/incident.entity';
import { IncidentMapper } from './incident.mapper';
import { IncidentResponseDto } from './dto/incident-response.dto';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { UpdateIncidentDto } from './dto/update-incident.dto';
import { ResolveIncidentDto } from './dto/resolve-incident.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { DownloadQueryDto } from '../s3/dto/download-link.dto';
import {
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../s3/photo-http';

@ApiTags('Incidents')
@ApiBearerAuth()
@Controller('incidents')
export class IncidentController {
  constructor(
    private readonly incidentService: IncidentService,
    private readonly incidentPhoto: IncidentPhotoService,
  ) {}

  /** El DTO de la incidencia con `photo_url` firmada si tiene foto en S3. */
  private async toDto(i: Incident): Promise<IncidentResponseDto> {
    await this.incidentPhoto.firmar(i);
    return IncidentMapper.toDto(i);
  }

  private async toDtos(is: Incident[]): Promise<IncidentResponseDto[]> {
    await this.incidentPhoto.firmar(is);
    return is.map((i) => IncidentMapper.toDto(i));
  }

  @Post()
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Reportar una incidencia de entrega (chofer durante el reparto)',
  })
  @ApiCreatedResponse({ type: IncidentResponseDto })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: orderId must be a UUID; type must be one of the following values: damaged, out_of_stock, no_show, other). `unpaid_collection` no se acepta acá: se crea con `PATCH /orders/{id}/payment/unpaid`',
  })
  async create(
    @Body() dto: CreateIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto> {
    return this.toDto(
      await this.incidentService.create(
        dto,
        user.user_id,
        distributorId,
        user.role === RoleType.DELIVERY,
      ),
    );
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Listar incidencias (scopeado por distribuidora)' })
  @ApiOkResponse({ type: IncidentResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto[]> {
    const incidents = await this.incidentService.findAll(distributorId);
    return this.toDtos(incidents);
  }

  @Get('order/:orderId')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Incidencias de un pedido' })
  @ApiParam({ name: 'orderId', description: 'Order UUID' })
  @ApiOkResponse({ type: IncidentResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  async findByOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto[]> {
    const incidents = await this.incidentService.findByOrder(
      orderId,
      distributorId,
    );
    if (user.role !== RoleType.DELIVERY) return this.toDtos(incidents);
    // Un chofer sólo ve la foto de lo que él reportó (igual que `GET :id/photo`).
    const propias = incidents.filter((i) => i.reportedBy === user.user_id);
    await this.incidentPhoto.firmar(propias);
    return incidents.map((i) => {
      const dto = IncidentMapper.toDto(i);
      if (i.reportedBy !== user.user_id) dto.photo_url = null;
      return dto;
    });
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Ficha de la incidencia (con pedido y cliente)' })
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiNotFoundResponse({
    description: 'La incidencia no existe o es de otra distribuidora',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto> {
    return this.toDto(await this.incidentService.findDetail(id, distributorId));
  }

  @Patch(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Editar descripción y tipo de una incidencia abierta',
    description:
      'Sólo mientras esté `open`. El tipo `unpaid_collection` no se asigna ni se cambia a mano (400). Eliminar una incidencia es descartarla con ' +
      'motivo: `PATCH /incidents/:id/resolve` con `status: discarded`. Nunca se borran.',
  })
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({
    description: 'La incidencia no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({ description: 'La incidencia ya no está abierta' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIncidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<IncidentResponseDto> {
    return this.toDto(
      await this.incidentService.update(id, dto, distributorId),
    );
  }

  // Distribuidora obligatoria, igual que `take`/`reopen`/`resolve` de reclamos:
  // un admin ya llega con la suya fijada por el guard; el super admin tiene
  // que elegir una (`X-Distributor`) en vez de resolver cross-tenant.
  @Patch(':id/resolve')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Resolver o descartar una incidencia',
    description:
      '`status: resolved` (default) la resuelve; `status: discarded` la ' +
      'descarta (baja lógica, sólo si está abierta). Ambos exigen ' +
      '`resolutionNote`.',
  })
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiNotFoundResponse({ description: 'Incidencia no encontrada' })
  @ApiConflictResponse({
    description: 'Se intenta descartar una no abierta, o tocar una descartada',
  })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora (header X-Distributor, sólo super admin) o datos inválidos (p. ej.: resolutionNote must be a string)',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveIncidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<IncidentResponseDto> {
    return this.toDto(
      await this.incidentService.resolve(id, dto, distributorId),
    );
  }

  @Put(':id/photo')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiSubirFoto(
    'Subir o reemplazar la foto de una incidencia',
    IncidentResponseDto,
    'La sube el chofer que la reportó o un admin de la distribuidora (403 ' +
      'para otro chofer).',
  )
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiForbiddenResponse({ description: 'La incidencia la reportó otro chofer' })
  @ApiConflictResponse({ description: 'La incidencia ya no está abierta' })
  @SubirFotoInterceptor()
  async uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto> {
    return IncidentMapper.toDto(
      await this.incidentPhoto.subir(id, user, distributorId, file),
    );
  }

  @Delete(':id/photo')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Sacar la foto de una incidencia',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano); ' +
      'si traía una `photo_url` externa, vuelve a valer. Mismos permisos que subirla.',
  })
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiNotFoundResponse({ description: 'Incidencia no encontrada' })
  @ApiForbiddenResponse({ description: 'La incidencia la reportó otro chofer' })
  @ApiConflictResponse({ description: 'La incidencia ya no está abierta' })
  async removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto> {
    return IncidentMapper.toDto(
      await this.incidentPhoto.quitar(id, user, distributorId),
    );
  }

  @Get(':id/photo')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiVerFoto('Ver la foto de una incidencia')
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiForbiddenResponse({ description: 'La incidencia la reportó otro chofer' })
  async getPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(
      res,
      query.modo,
      await this.incidentPhoto.enlace(id, user, distributorId),
    );
  }
}
