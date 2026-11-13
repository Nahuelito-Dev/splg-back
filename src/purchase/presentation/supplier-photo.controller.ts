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
import { DownloadQueryDto } from '../../s3/dto/download-link.dto';
import { PhotoCurrentResponseDto } from '../../s3/dto/photo-link.dto';
import {
  aFotoVigente,
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../../s3/photo-http';
import { SupplierPhotoService } from '../application/supplier-photo.service';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Foto principal del proveedor (API v2). */
@ApiTags('Compras · Proveedores')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'suppliers', version: '2' })
export class SupplierPhotoController {
  constructor(private readonly photo: SupplierPhotoService) {}

  @Permiso('compras.gestionar')
  @Put(':id/photo')
  @ApiSubirFoto(
    'Subir o reemplazar la foto principal del proveedor',
    PhotoCurrentResponseDto,
    'Devuelve el enlace vigente `{ url, expiresAt }`.',
  )
  @ApiParam({ name: 'id', description: 'Proveedor UUID' })
  @SubirFotoInterceptor()
  async subir(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PhotoCurrentResponseDto> {
    return aFotoVigente(await this.photo.subir(id, distributorId, file));
  }

  @Permiso('compras.gestionar')
  @Delete(':id/photo')
  @ApiOperation({
    summary: 'Sacar la foto del proveedor',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano); no da de baja al proveedor. Devuelve `{ url: null, expiresAt: null }`.',
  })
  @ApiParam({ name: 'id', description: 'Proveedor UUID' })
  @ApiOkResponse({ type: PhotoCurrentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async quitar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PhotoCurrentResponseDto> {
    return aFotoVigente(await this.photo.quitar(id, distributorId));
  }

  @Permiso('stock.ver')
  @Get(':id/photo')
  @ApiVerFoto('Ver la foto del proveedor')
  @ApiParam({ name: 'id', description: 'Proveedor UUID' })
  async ver(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(res, query.modo, await this.photo.enlace(id, distributorId));
  }
}
