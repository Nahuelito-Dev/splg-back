import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Res,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { DownloadQueryDto } from '../../s3/dto/download-link.dto';
import { PhotoCurrentResponseDto } from '../../s3/dto/photo-link.dto';
import {
  aFotoVigente,
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../../s3/photo-http';
import { TruckLoadAccessService } from '../application/truck-load-access.service';
import { TruckLoadPhotoService } from '../application/truck-load-photo.service';

/** Foto principal de la carga (API v2). */
@ApiTags('Cargas de camión')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'truck-loads', version: '2' })
export class TruckLoadPhotoController {
  constructor(
    private readonly photo: TruckLoadPhotoService,
    private readonly access: TruckLoadAccessService,
  ) {}

  @Put(':id/photo')
  @ApiSubirFoto(
    'Subir o reemplazar la foto principal de la carga',
    PhotoCurrentResponseDto,
    'Devuelve el enlace vigente `{ url, expiresAt }`.',
  )
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @SubirFotoInterceptor()
  async subir(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PhotoCurrentResponseDto> {
    return aFotoVigente(await this.photo.subir(id, distributorId, file));
  }

  @Delete(':id/photo')
  @ApiOperation({
    summary: 'Sacar la foto de la carga',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano); no da de baja la carga. Devuelve `{ url: null, expiresAt: null }`.',
  })
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  @ApiOkResponse({ type: PhotoCurrentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async quitar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PhotoCurrentResponseDto> {
    return aFotoVigente(await this.photo.quitar(id, distributorId));
  }

  @Get(':id/photo')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiVerFoto('Ver la foto de la carga')
  @ApiParam({ name: 'id', description: 'Carga UUID' })
  async ver(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const enlace = await this.photo.enlace(
      id,
      distributorId,
      await this.access.alcanceDe(user),
    );
    responderFoto(res, query.modo, enlace);
  }
}
