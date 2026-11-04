import {
  Controller,
  Delete,
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
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClaimsService } from './claims.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimDto } from './dto/update-claim.dto';
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
import { QueryMyClaimsDto } from './dto/query-my-claims.dto';
import { MyClaimResponseDto } from './dto/my-claim-response.dto';
import { CABECERA_TOTAL, informarTotal } from '../common/http/total';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { ClaimPhotoLinkResponseDto } from './dto/claim-photo-link.dto';
import { ClaimMapper } from './claims.mapper';
import type { Claim } from './entities/claim.entity';
import { ArchivoIdempotente } from '../s3/upload-limits';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';
import { DownloadMode, DownloadQueryDto } from '../s3/dto/download-link.dto';
import { aEnlaceDeDescarga } from '../s3/download-link';
import { Idempotent } from '../common/decorators/idempotent.decorator';
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
  @Idempotent()
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cliente crea un reclamo' })
  @ApiCreatedResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({ description: 'El pedido no existe' })
  @ApiBadRequestResponse({ description: 'El pedido no es del cliente' })
  async create(
    @Body() createClaimDto: CreateClaimDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
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

  @Get('mine')
  @Auth(RoleType.CUSTOMER)
  @ApiOperation({
    summary: 'El cliente ve sus propios reclamos',
    description:
      'Del más nuevo al más viejo, paginado con `limit` y `offset`; el total ' +
      'sin paginar viaja en la cabecera `X-Total-Count`. Con `X-Distributor` ' +
      'sólo los de esa distribuidora; sin el header, los de todas.',
  })
  // El 200 lleva la cabecera del total en la misma respuesta: `ApiTotal` aparte
  // pisaría este `ApiOkResponse` en el OpenAPI.
  @ApiOkResponse({
    type: MyClaimResponseDto,
    isArray: true,
    headers: {
      [CABECERA_TOTAL]: {
        description: 'Total de reclamos del cliente sin paginar',
        schema: { type: 'integer' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'limit u offset inválidos' })
  async findMine(
    @Query() query: QueryMyClaimsDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<MyClaimResponseDto[]> {
    const [claims, total] = await this.claimsService.findMine(
      user.user_id,
      query,
      distributorId,
    );
    informarTotal(res, total);
    return Promise.all(
      claims.map(async (c) =>
        ClaimMapper.toMyDto(c, await this.claimsService.photoUrlFor(c)),
      ),
    );
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Ficha del reclamo (con pedido y cliente)' })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ClaimResponseDto> {
    return this.toDto(await this.claimsService.findDetail(id, distributorId));
  }

  @Patch(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Editar motivo y descripción de un reclamo pendiente',
    description:
      'Sólo mientras esté `pending` (nadie lo tomó). Eliminar un reclamo es ' +
      'rechazarlo con motivo: `PATCH /claims/:id/resolve` con `status: rejected`. ' +
      'Los reclamos nunca se borran.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({
    description: 'El reclamo no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({ description: 'El reclamo ya no está pendiente' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateClaimDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ClaimResponseDto> {
    return this.toDto(await this.claimsService.update(id, body, distributorId));
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
      'Falta la distribuidora (header X-Distributor, sólo super admin) o datos inválidos (p. ej.: Resolución: no puede estar vacío; Estado: elegí una opción válida (resuelto o rechazado)) ' +
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
      'Falta la distribuidora (header X-Distributor, sólo super admin), datos inválidos (Motivo: no puede estar vacío) o el reclamo no está resuelto ni rechazado',
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
      'foto, la anterior se borra del bucket. La puede subir el cliente dueño ' +
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
  @ArchivoIdempotente(MAX_ATTACHMENT_SIZE_BYTES, 'foto')
  async uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<ClaimResponseDto> {
    return this.toDto(
      await this.claimsService.uploadPhoto(id, file, distributorId, {
        userId: user.user_id,
        role: user.role,
      }),
    );
  }

  @Delete(':id/photo')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Sacar la foto de un reclamo',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano). ' +
      'La puede sacar el cliente dueño del reclamo o un admin de la ' +
      'distribuidora, y sólo mientras el reclamo no esté resuelto ni ' +
      'rechazado (409). Sin foto es idempotente: responde igual.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({ type: ClaimResponseDto })
  @ApiNotFoundResponse({
    description:
      'El reclamo no existe, no es del cliente o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'El reclamo está resuelto o rechazado: se reabre antes',
  })
  async removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<ClaimResponseDto> {
    return this.toDto(
      await this.claimsService.removePhoto(id, distributorId, {
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
      '(302 a la URL firmada de S3). Con ' +
      '`?modo=url` devuelve `{ url, expiresAt, requiresAuth }` en JSON, sin ' +
      'redirect; si el reclamo no tiene foto, 200 con `url: null`. ' +
      'Se puede ver aunque el reclamo esté cerrado.',
  })
  @ApiParam({ name: 'id', description: 'Claim UUID' })
  @ApiOkResponse({
    description:
      'La foto; con `?modo=url`, el enlace (`url: null` si no tiene foto)',
    type: ClaimPhotoLinkResponseDto,
  })
  @ApiNotFoundResponse({
    description:
      'El reclamo no existe o no es del cliente; sin `modo`, también si no tiene foto',
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
      const link = await this.claimsService.getPhotoLink(
        id,
        distributorId,
        actor,
      );
      if (link.kind !== 'stored') {
        const dto = new ClaimPhotoLinkResponseDto();
        dto.url = null;
        dto.expiresAt = null;
        dto.requiresAuth = false;
        res.json(dto);
        return;
      }
      res.json(aEnlaceDeDescarga(link.signed));
      return;
    }

    const url = await this.claimsService.getPhotoFile(id, distributorId, actor);
    res.redirect(HttpStatus.FOUND, url);
  }
}
