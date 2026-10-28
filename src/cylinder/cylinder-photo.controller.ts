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
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { DownloadQueryDto } from '../s3/dto/download-link.dto';
import { PhotoCurrentResponseDto } from '../s3/dto/photo-link.dto';
import {
  aFotoVigente,
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../s3/photo-http';
import { CylinderPhotoService } from './cylinder-photo.service';

/** Foto principal del envase (API v2). */
@ApiTags('Cylinders')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'cylinders', version: '2' })
export class CylinderPhotoController {
  constructor(private readonly photo: CylinderPhotoService) {}

  @Put(':id/photo')
  @ApiSubirFoto(
    'Subir o reemplazar la foto principal del envase',
    PhotoCurrentResponseDto,
    'Devuelve el enlace vigente `{ url, expiresAt }`.',
  )
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
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
    summary: 'Sacar la foto del envase',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano); no retira el envase. Devuelve `{ url: null, expiresAt: null }`.',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
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
  @ApiVerFoto('Ver la foto del envase')
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  async ver(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(res, query.modo, await this.photo.enlace(id, distributorId));
  }
}
