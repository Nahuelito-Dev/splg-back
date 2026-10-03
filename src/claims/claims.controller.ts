import {
  Controller,
  Get,
  HttpStatus,
  Post,
  Body,
  Patch,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ClaimsService } from './claims.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { ResolveClaimDto } from './dto/resolve-claim.dto';
import { ReopenClaimDto } from './dto/reopen-claim.dto';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { ClaimMapper } from './claims.mapper';
import type { Claim } from './entities/claim.entity';
import { servirArchivo } from '../common/http/servir-archivo';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';
import {
  DownloadLinkResponseDto,
  DownloadMode,
  DownloadQueryDto,
} from '../storage/dto/download-link.dto';
import { aEnlaceDeDescarga } from '../storage/download-link';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('Claims')
@ApiBearerAuth()
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  /** El DTO del reclamo con `photoUrl` como URL firmada vigente. */
  private async toDto(claim: Claim): Promise<ClaimResponseDto> {
    return ClaimMapper.toDto(
      claim,
      await this.claimsService.photoUrlFor(claim),
    );
  }

  @Post()
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cliente crea un reclamo' })
  @ApiCreatedResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({ description: 'El pedido no existe' })
  @ApiBadRequestResponse({ description: 'El pedido no es del cliente' })
  async create(
    @Body() createClaimDto: CreateClaimDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ClaimResponseDto> {
    // Anti-impersonación: un cliente solo puede reclamar como SÍ MISMO (se
    // fuerza el customerId al del token, ignorando lo que venga en el body).
    // Un admin puede crear a nombre de un cliente (soporte). El distributor_id
    // NO sale del header: se deriva de la orden reclamada (claims.service).
    const isAdmin =
      user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN;
    const dto = isAdmin
      ? createClaimDto
      : { ...createClaimDto, customerId: user.user_id };
    // Al admin lo acota su distribuidora; al cliente, que el pedido sea suyo.
    return this.toDto(
      await this.claimsService.create(dto, isAdmin ? distributorId : null),
    );
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Admin ve todos los reclamos' })
  @ApiOkResponse({ type: ClaimResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ClaimResponseDto[]> {
    const claims = await this.claimsService.findAll(distributorId);
    return Promise.all(claims.map((c) => this.toDto(c)));
  }

  @Patch(':id/resolve')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin resuelve un reclamo',
    description:
      'Deja el reclamo en RESOLVED o REJECTED, con nota obligatoria ' +
      '(CU-025). La transición se valida contra la máquina de estados: un ' +
      'reclamo RESOLVED o REJECTED no se vuelve a resolver sin reabrirlo antes ' +
      '(`PATCH /claims/:id/reopen`). Pasar a IN_PROCESS es `PATCH /claims/:id/take`.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora (header X-Distributor, sólo super admin) o datos inválidos (p. ej.: resolution should not be empty; status debe ser uno de: resolved, rejected) ' +
      'o transición de reclamo inválida (p. ej.: resolved → rejected sin reabrir antes)',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveClaimDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ClaimResponseDto> {
    return this.toDto(
      await this.claimsService.resolve(
        id,
        body.resolution,
        body.status,
        distributorId,
      ),
    );
  }

  @Patch(':id/take')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin toma un reclamo pendiente para revisarlo',
    description:
      'PENDING → IN_PROCESS. Sin nota: sólo marca que un admin ya está mirando ' +
      'el reclamo (distinto de `resolve`, que exige nota de resolución).',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora (header X-Distributor, sólo super admin) o el reclamo no está pendiente (ya fue tomado, resuelto o rechazado)',
  })
  async take(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ClaimResponseDto> {
    return this.toDto(await this.claimsService.take(id, distributorId));
  }

  @Patch(':id/reopen')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Admin reabre un reclamo resuelto o rechazado',
    description:
      'RESOLVED/REJECTED → IN_PROCESS, con motivo obligatorio. Nunca vuelve a ' +
      'PENDING: alguien ya lo había tomado.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora (header X-Distributor, sólo super admin), datos inválidos (reason should not be empty) o el reclamo no está resuelto ni rechazado',
  })
  async reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReopenClaimDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ClaimResponseDto> {
    return this.toDto(
      await this.claimsService.reopen(id, body.reason, distributorId),
    );
  }

  @Post(':id/photo')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Subir o reemplazar la foto de un reclamo (CU-174)',
    description:
      'Multipart, campo `file`: JPG, PNG o WEBP de hasta 10 MB (el tipo se ' +
      'valida por el contenido, no por el header). Sólo mientras el reclamo no ' +
      'esté resuelto ni rechazado (409). Si ya tenía ' +
      'foto, la anterior se borra del storage. La puede subir el cliente dueño ' +
      'del reclamo o un admin de la distribuidora.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description:
      'El reclamo no existe, no es del cliente o es de otra distribuidora',
  })
  @ApiBadRequestResponse({ description: 'Falta la foto o está vacía' })
  @ApiConflictResponse({
    description: 'El reclamo está resuelto o rechazado: se reabre antes',
  })
  @ApiUnsupportedMediaTypeResponse({
    description: 'No es JPG, PNG ni WEBP (o el contenido no coincide)',
  })
  @ApiPayloadTooLargeResponse({ description: 'La foto supera los 10 MB' })
  @UseInterceptors(
    FileInterceptor('file', {
      // Techo técnico por arriba del límite de negocio (el 413 documentado lo
      // da ClaimsService): sólo una salvaguarda contra abuso.
      limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES * 2 },
    }),
  )
  async uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ClaimResponseDto> {
    return this.toDto(
      await this.claimsService.uploadPhoto(id, file, distributorId, {
        userId: user.user_id,
        role: user.role,
      }),
    );
  }

  @Get(':id/photo')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Ver la foto de un reclamo (CU-175)',
    description:
      'Igual que las descargas de adjuntos: por defecto devuelve la foto ' +
      '(302 a la URL firmada con S3, o streaming con el driver local). Con ' +
      '`?modo=url` devuelve `{ url, expiresAt, requiresAuth }` en JSON, sin ' +
      'redirect (con el driver local `url` es esta misma ruta y se pide con el ' +
      'token). Se puede ver aunque el reclamo esté cerrado.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({
    description: 'La foto; con `?modo=url`, el enlace',
    type: DownloadLinkResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe, no es del cliente o no tiene foto',
  })
  async getPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const actor = { userId: user.user_id, role: user.role };

    if (query.modo === DownloadMode.URL) {
      const signed = await this.claimsService.getPhotoSignedDownload(
        id,
        distributorId,
        actor,
      );
      res.json(aEnlaceDeDescarga(signed, req.originalUrl.split('?')[0]));
      return;
    }

    const photo = await this.claimsService.getPhotoFile(
      id,
      distributorId,
      actor,
    );
    if (photo.kind === 'redirect') {
      res.redirect(HttpStatus.FOUND, photo.url);
      return;
    }
    servirArchivo(res, photo);
  }
}
