import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBody,
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
import { FleetTaskService } from './fleet-task.service';
import { FleetAttachmentService } from './fleet-attachment.service';
import { FleetTaskMapper } from './fleet-task.mapper';
import { FleetAttachmentMapper } from './fleet-attachment.mapper';
import { CreateFleetTaskDto } from './dto/create-task.dto';
import { UpdateFleetTaskDto } from './dto/update-task.dto';
import { CloseFleetTaskDto } from './dto/close-task.dto';
import { CancelFleetTaskDto } from './dto/cancel-task.dto';
import { QueryFleetTaskDto } from './dto/query-task.dto';
import { FleetTaskResponseDto } from './dto/task-response.dto';
import { FleetTaskAttachmentResponseDto } from './dto/attachment-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MAX_ATTACHMENT_SIZE_BYTES } from './domain/attachment-rules';

/**
 * Tareas de flota: cada vencimiento/servicio concreto (CU-136 a CU-141) y sus
 * adjuntos (la foto o el PDF de la póliza, la VTV, la licencia).
 */
@ApiTags('Fleet · Tasks')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('fleet/tasks')
export class FleetTaskController {
  constructor(
    private readonly tasksService: FleetTaskService,
    private readonly attachmentsService: FleetAttachmentService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Crear una tarea contra un plan' })
  @ApiCreatedResponse({ type: FleetTaskResponseDto })
  @ApiBadRequestResponse({
    description: 'El vehículo/chofer no coincide con el subject del plan',
  })
  @ApiNotFoundResponse({ description: 'Plan, vehículo o chofer no encontrado' })
  async create(
    @Body() dto: CreateFleetTaskDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskResponseDto> {
    return FleetTaskMapper.toDto(
      await this.tasksService.create(dto, distributorId),
    );
  }

  @Get()
  @ApiOperation({ summary: 'Listar tareas, con filtros' })
  @ApiOkResponse({ type: FleetTaskResponseDto, isArray: true })
  async findAll(
    @Query() query: QueryFleetTaskDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskResponseDto[]> {
    const tasks = await this.tasksService.findAll(distributorId, query);
    return tasks.map((t) => FleetTaskMapper.toDto(t));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ver una tarea, con sus adjuntos' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskResponseDto })
  @ApiNotFoundResponse({ description: 'Tarea no encontrada' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskResponseDto> {
    const task = await this.tasksService.findOne(id, distributorId);
    const attachments = await this.attachmentsService.list(id, distributorId);
    return FleetTaskMapper.toDto(task, attachments);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar una tarea abierta' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskResponseDto })
  @ApiNotFoundResponse({ description: 'Tarea no encontrada' })
  @ApiBadRequestResponse({ description: 'La tarea ya está hecha o cancelada' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFleetTaskDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskResponseDto> {
    return FleetTaskMapper.toDto(
      await this.tasksService.update(id, dto, distributorId),
    );
  }

  @Patch(':id/close')
  @ApiOperation({
    summary: 'CU-141: registrar que el mantenimiento/habilitación se hizo',
  })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskResponseDto })
  @ApiNotFoundResponse({ description: 'Tarea no encontrada' })
  @ApiBadRequestResponse({ description: 'La tarea ya está hecha o cancelada' })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseFleetTaskDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskResponseDto> {
    return FleetTaskMapper.toDto(
      await this.tasksService.close(id, dto, distributorId),
    );
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancelar una tarea abierta' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskResponseDto })
  @ApiNotFoundResponse({ description: 'Tarea no encontrada' })
  @ApiBadRequestResponse({ description: 'La tarea ya está hecha o cancelada' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelFleetTaskDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskResponseDto> {
    return FleetTaskMapper.toDto(
      await this.tasksService.cancel(id, dto, distributorId),
    );
  }

  @Post(':id/attachments')
  @ApiOperation({
    summary: 'Subir un adjunto (póliza, VTV, licencia, comprobante)',
  })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: FleetTaskAttachmentResponseDto })
  @ApiNotFoundResponse({ description: 'Tarea no encontrada' })
  @ApiBadRequestResponse({ description: 'Falta el archivo' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'Tipo de archivo no permitido (sólo PDF, JPG, PNG, WEBP)',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El archivo supera el máximo permitido',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      // Techo técnico por arriba del límite de negocio (ver
      // MAX_ATTACHMENT_SIZE_BYTES en FleetAttachmentService, que da el 413
      // documentado): esto es sólo una salvaguarda contra abuso.
      limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES * 2 },
    }),
  )
  async uploadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FleetTaskAttachmentResponseDto> {
    return FleetAttachmentMapper.toDto(
      await this.attachmentsService.upload(id, distributorId, file, userId),
    );
  }

  @Get(':id/attachments')
  @ApiOperation({ summary: 'Listar los adjuntos de una tarea' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskAttachmentResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Tarea no encontrada' })
  async listAttachments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskAttachmentResponseDto[]> {
    const attachments = await this.attachmentsService.list(id, distributorId);
    return attachments.map((a) => FleetAttachmentMapper.toDto(a));
  }

  @Get(':id/attachments/:attachmentId/download')
  @ApiOperation({
    summary:
      'Descargar un adjunto: redirige a una URL firmada (S3) o sirve el archivo (local)',
  })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiOkResponse({ description: 'El archivo, con su content-type original' })
  @ApiNotFoundResponse({ description: 'Tarea o adjunto no encontrado' })
  async downloadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Res() res: Response,
  ): Promise<void> {
    const download = await this.attachmentsService.getDownload(
      id,
      attachmentId,
      distributorId,
    );

    if (download.kind === 'redirect') {
      res.redirect(HttpStatus.FOUND, download.url);
      return;
    }

    res.set({
      'Content-Type': download.mimeType,
      'Content-Disposition': `attachment; filename="${download.fileName}"`,
      ...(download.sizeBytes
        ? { 'Content-Length': String(download.sizeBytes) }
        : {}),
    });
    download.stream.pipe(res);
  }

  @Delete(':id/attachments/:attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un adjunto' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiOkResponse({ description: 'Borrado' })
  @ApiNotFoundResponse({ description: 'Tarea o adjunto no encontrado' })
  async removeAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<void> {
    await this.attachmentsService.remove(id, attachmentId, distributorId);
  }
}
