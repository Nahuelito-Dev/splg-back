import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  Version,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { archivoConTope } from '../s3/upload-limits';
import { ImportFormat, ImportResource } from './domain/import.enums';
import { MAX_ARCHIVO_BYTES, MAX_FILAS } from './domain/import.types';
import {
  ImportConfirmResponseDto,
  ImportPreviewResponseDto,
  ImportTemplateQueryDto,
} from './dto/import.dto';
import { ImportHandlerRegistry } from './import-handler.registry';
import { ImportMapper } from './import.mapper';
import { ImportService } from './import.service';
import { ImportTemplateService } from './import-template.service';
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Carga masiva desde Excel o CSV, en tres pasos: plantilla, vista previa (valida
 * todo, no escribe nada) y confirmación (aplica todo o nada). API v2.
 */
@ApiTags('Importación masiva')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('imports')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly handlers: ImportHandlerRegistry,
    private readonly plantillas: ImportTemplateService,
  ) {}

  @Permiso('catalogo.ver')
  @Get(':recurso/template')
  @Version('2')
  @ApiOperation({
    summary: 'Descargar la plantilla de un recurso',
    description:
      'Encabezados en castellano y una fila de ejemplo (borrala antes de subir el archivo: se importa como cualquier otra). ' +
      'Recursos: `garrafas` (catálogo), `precios` (actualización por tipo), `stock` (stock inicial o ajuste por depósito) y `proveedores`.',
  })
  @ApiParam({ name: 'recurso', enum: ImportResource })
  @ApiOkResponse({
    description: 'El archivo de la plantilla (.xlsx por defecto, o .csv)',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiBadRequestResponse({ description: 'Recurso o formato no válido' })
  async template(
    @Param('recurso', new ParseEnumPipe(ImportResource))
    recurso: ImportResource,
    @Query() query: ImportTemplateQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const plantilla = await this.plantillas.generar(
      this.handlers.de(recurso).columnas,
      query.format ?? ImportFormat.XLSX,
    );
    res.set({
      'Content-Type': plantilla.tipo,
      'Content-Disposition': `attachment; filename="plantilla-${recurso}.${plantilla.extension}"`,
    });
    return new StreamableFile(plantilla.contenido);
  }

  @Permiso('catalogo.gestionar')
  @Post(':recurso/preview')
  @Version('2')
  @UseInterceptors(archivoConTope(MAX_ARCHIVO_BYTES, 'archivo'))
  @ApiOperation({
    summary: 'Subir el archivo y ver la vista previa',
    description:
      `Multipart, campo \`file\`: .xlsx o .csv de hasta 5 MB y ${MAX_FILAS} filas. CSV con \`;\` o \`,\`, UTF-8 con o sin BOM, coma decimal. ` +
      'Valida TODAS las filas con las mismas reglas que el alta unitaria y devuelve los errores por fila y columna. ' +
      'No escribe nada del negocio: guarda la vista previa 24 h. Si no hay errores se confirma con `POST /imports/{importId}/confirm`.',
  })
  @ApiParam({ name: 'recurso', enum: ImportResource })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: ImportPreviewResponseDto })
  @ApiBadRequestResponse({
    description:
      'Falta el archivo, está vacío, supera las filas permitidas o el encabezado no coincide con la plantilla',
  })
  @ApiUnsupportedMediaTypeResponse({
    description: 'No es un .xlsx ni un .csv (o el contenido no coincide)',
  })
  @ApiPayloadTooLargeResponse({ description: 'El archivo supera los 5 MB' })
  async preview(
    @Param('recurso', new ParseEnumPipe(ImportResource))
    recurso: ImportResource,
    @UploadedFile() archivo: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ImportPreviewResponseDto> {
    const job = await this.imports.preview(
      recurso,
      archivo,
      distributorId,
      actorUserId,
    );
    return ImportMapper.toPreviewDto(job);
  }

  @Permiso('catalogo.gestionar')
  @Post(':importId/confirm')
  @Version('2')
  @Idempotent()
  @ApiOperation({
    summary: 'Confirmar la importación',
    description:
      'Aplica la vista previa en UNA transacción: si una fila falla, no se guarda nada. ' +
      'Idempotente: confirmar dos veces la misma importación no duplica (la segunda devuelve el mismo resumen con `yaConfirmada: true`).',
  })
  @ApiParam({ name: 'importId', format: 'uuid' })
  @ApiCreatedResponse({ type: ImportConfirmResponseDto })
  @ApiBadRequestResponse({
    description:
      'La vista previa tiene errores, o una fila no se pudo aplicar (el mensaje dice cuál)',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiGoneResponse({ description: 'La vista previa venció (24 h)' })
  async confirm(
    @Param('importId', ParseUUIDPipe) importId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<ImportConfirmResponseDto> {
    const { job, yaConfirmada } = await this.imports.confirm(
      importId,
      distributorId,
      actorUserId,
    );
    return ImportMapper.toConfirmDto(job, yaConfirmada);
  }
}
