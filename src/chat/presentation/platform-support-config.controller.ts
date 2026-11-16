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
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { PermisoDePlataforma } from '../../common/permisos/catalogo-de-plataforma';
import { MessageTemplatesService } from '../application/message-templates.service';
import { SupportSettingsService } from '../application/support-settings.service';
import {
  CreateMessageTemplateDto,
  MessageTemplateListResponseDto,
  MessageTemplateResponseDto,
  QueryMessageTemplatesDto,
  SupportSettingsResponseDto,
  UpdateMessageTemplateDto,
  UpdateSupportSettingsDto,
} from './dto/support-settings.dto';
import { ajustesADto, plantillaADto } from './support-config.mapper';

/**
 * Configuración del soporte de la plataforma (diseño §14.5): horario del chat,
 * objetivos de primera respuesta, plazos de los cierres automáticos y
 * respuestas guardadas. Sólo administrador general, alcance `plataforma`.
 */
@ApiTags('Support settings (platform)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform', version: '2' })
export class PlatformSupportConfigController {
  constructor(
    private readonly ajustes: SupportSettingsService,
    private readonly plantillas: MessageTemplatesService,
  ) {}

  @Get('support-settings')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Configuración del soporte',
    description: 'Sin configuración guardada, los valores por defecto.',
  })
  @ApiOkResponse({ type: SupportSettingsResponseDto })
  async leer(): Promise<SupportSettingsResponseDto> {
    return ajustesADto(await this.ajustes.leer());
  }

  @Put('support-settings')
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Cambiar la configuración del soporte',
    description:
      'Lo que no viene queda como estaba. Incluye el asistente con IA del soporte (`assistantAiEnabled`) y sus topes, que valen también para el chat de cada empresa con sus clientes.',
  })
  @ApiOkResponse({ type: SupportSettingsResponseDto })
  @ApiBadRequestResponse({
    description:
      'Valor fuera de rango (también los topes del asistente con IA: 1–50 respuestas por conversación, 10.000–1.000.000.000 tokens por mes, en total y por empresa), cupo por empresa mayor que el total del soporte, zona horaria desconocida, franjas solapadas o aviso que no llega antes del cierre',
  })
  async actualizar(
    @CurrentUser('user_id') userId: string,
    @Body() dto: UpdateSupportSettingsDto,
  ): Promise<SupportSettingsResponseDto> {
    return ajustesADto(await this.ajustes.actualizar(userId, dto));
  }

  @Get('ticket-templates')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({ summary: 'Respuestas guardadas del soporte' })
  @ApiOkResponse({ type: MessageTemplateListResponseDto })
  @ApiBadRequestResponse({ description: 'Alcance desconocido' })
  async listarPlantillas(
    @Query() query: QueryMessageTemplatesDto,
  ): Promise<MessageTemplateListResponseDto> {
    return { items: (await this.plantillas.listar(query)).map(plantillaADto) };
  }

  @Post('ticket-templates')
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Nueva respuesta guardada',
    description:
      'La de alcance `auto_reply` y clave `fuera_de_horario` es la que el chat manda fuera de horario.',
  })
  @ApiCreatedResponse({ type: MessageTemplateResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({
    description: 'Ya hay una con esa clave (`MESSAGE_TEMPLATE_KEY_TAKEN`)',
  })
  async crearPlantilla(
    @Body() dto: CreateMessageTemplateDto,
  ): Promise<MessageTemplateResponseDto> {
    return plantillaADto(await this.plantillas.crear(dto));
  }

  @Patch('ticket-templates/:id')
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({ summary: 'Editar una respuesta guardada' })
  @ApiOkResponse({ type: MessageTemplateResponseDto })
  @ApiBadRequestResponse({ description: 'Id que no es UUID o datos inválidos' })
  @ApiNotFoundResponse({ description: 'No existe' })
  async editarPlantilla(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMessageTemplateDto,
  ): Promise<MessageTemplateResponseDto> {
    return plantillaADto(await this.plantillas.actualizar(id, dto));
  }

  @Delete('ticket-templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PermisoDePlataforma('plataforma.tickets.configurar')
  @ApiOperation({
    summary: 'Dar de baja una respuesta guardada',
    description: 'Baja lógica: deja de ofrecerse y su clave queda libre.',
  })
  @ApiNoContentResponse({ description: 'Dada de baja' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe' })
  async bajaDePlantilla(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.plantillas.darDeBaja(id);
  }
}
