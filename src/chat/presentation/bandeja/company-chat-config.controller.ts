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
import { RoleType } from '../../../common/constants/role-type.enum';
import { Auth } from '../../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Permiso } from '../../../common/decorators/permiso.decorator';
import { RequiereModulo } from '../../../platform/access/requiere-modulo.decorator';
import {
  CompanyChatSettingsService,
  horarioDe,
  textoDeRecibido,
  textoFueraDeHorario,
} from '../../application/company-chat-settings.service';
import { CompanyTemplatesService } from '../../application/company-templates.service';
import {
  atiendeLaEmpresa,
  proximaAtencion,
} from '../../domain/horario-de-la-empresa';
import type { ChatCompanySettings } from '../../entities/chat-company-settings.entity';
import type { MessageTemplate } from '../../entities/message-template.entity';
import {
  CreateCompanyTemplateDto,
  QueryCompanyTemplatesDto,
  UpdateChatBusinessHoursDto,
  UpdateChatSettingsDto,
  UpdateCompanyTemplateDto,
} from '../dto/bandeja-input.dto';
import {
  ChatBusinessHoursResponseDto,
  ChatSettingsResponseDto,
  CompanyTemplateListResponseDto,
  CompanyTemplateResponseDto,
} from '../dto/bandeja-response.dto';

function estado(a: ChatCompanySettings): {
  openNow: boolean;
  nextOpenAt: string | null;
} {
  const ahora = new Date();
  const h = horarioDe(a);
  return {
    openNow: atiendeLaEmpresa(h, ahora),
    nextOpenAt: proximaAtencion(h, ahora)?.toISOString() ?? null,
  };
}

function ajustesADto(a: ChatCompanySettings): ChatSettingsResponseDto {
  return {
    customerChatEnabled: a.customerChatEnabled,
    outOfHoursEnabled: a.outOfHoursEnabled,
    outOfHoursMessage: a.outOfHoursMessage,
    effectiveOutOfHoursMessage: textoFueraDeHorario(a),
    ackEnabled: a.ackEnabled,
    ackMessage: a.ackMessage,
    effectiveAckMessage: textoDeRecibido(a),
    firstResponseTargetMinutes: a.firstResponseTargetMinutes,
    ...estado(a),
  };
}

function horarioADto(a: ChatCompanySettings): ChatBusinessHoursResponseDto {
  return {
    timezone: a.timezone,
    days: a.businessHours,
    holidays: a.holidays,
    ...estado(a),
  };
}

function plantillaADto(t: MessageTemplate): CompanyTemplateResponseDto {
  return {
    id: t.templateId,
    channel: t.channel,
    key: t.key,
    title: t.title,
    body: t.body,
    active: t.active,
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * Configuración de la bandeja de la empresa (diseño §14.3): parámetros,
 * horario de atención y respuestas guardadas. Leer: cualquiera que atienda
 * mensajes; cambiar: `mensajes.configurar`. Módulo `chat`.
 */
@ApiTags('Inbox settings (company)')
@RequiereModulo('chat')
@Permiso('mensajes.clientes', 'mensajes.choferes', 'mensajes.configurar')
@Auth(RoleType.ADMIN)
@Controller({ path: 'chat', version: '2' })
export class CompanyChatConfigController {
  constructor(
    private readonly ajustes: CompanyChatSettingsService,
    private readonly plantillas: CompanyTemplatesService,
  ) {}

  @Get('settings')
  @ApiOperation({
    summary: 'Parámetros de la bandeja',
    description:
      'Con los textos que se mandan de verdad (`effective*`) y si la empresa atiende ahora.',
  })
  @ApiOkResponse({ type: ChatSettingsResponseDto })
  async leer(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ChatSettingsResponseDto> {
    return ajustesADto(await this.ajustes.leer(distributorId));
  }

  @Put('settings')
  @Permiso('mensajes.configurar')
  @ApiOperation({
    summary: 'Cambiar los parámetros de la bandeja',
    description: 'Lo que no viene queda como estaba.',
  })
  @ApiOkResponse({ type: ChatSettingsResponseDto })
  @ApiBadRequestResponse({
    description:
      'Valor fuera de rango, texto vacío o de más de 500, o variable desconocida (`TEMPLATE_VARIABLE_UNKNOWN`)',
  })
  async actualizar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Body() dto: UpdateChatSettingsDto,
  ): Promise<ChatSettingsResponseDto> {
    return ajustesADto(
      await this.ajustes.actualizar(distributorId, userId, dto),
    );
  }

  @Get('business-hours')
  @ApiOperation({ summary: 'Horario de atención del chat' })
  @ApiOkResponse({ type: ChatBusinessHoursResponseDto })
  async horario(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<ChatBusinessHoursResponseDto> {
    return horarioADto(await this.ajustes.leer(distributorId));
  }

  @Put('business-hours')
  @Permiso('mensajes.configurar')
  @ApiOperation({
    summary: 'Cambiar el horario de atención del chat',
    description:
      'Franjas por día de la semana (0 = domingo, sin solaparse) y días sin atención. Lo que no viene queda como estaba.',
  })
  @ApiOkResponse({ type: ChatBusinessHoursResponseDto })
  @ApiBadRequestResponse({
    description:
      'Zona horaria inválida, franjas solapadas o que cierran antes de abrir, fecha inválida o repetida',
  })
  async actualizarHorario(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Body() dto: UpdateChatBusinessHoursDto,
  ): Promise<ChatBusinessHoursResponseDto> {
    return horarioADto(
      await this.ajustes.actualizarHorario(distributorId, userId, dto),
    );
  }

  @Get('templates')
  @ApiOperation({
    summary: 'Respuestas guardadas de la empresa',
    description: 'Con `channel`, las de ese canal y las de los dos.',
  })
  @ApiOkResponse({ type: CompanyTemplateListResponseDto })
  @ApiBadRequestResponse({ description: 'Canal o `active` inválidos' })
  async listarPlantillas(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Query() query: QueryCompanyTemplatesDto,
  ): Promise<CompanyTemplateListResponseDto> {
    return {
      items: (await this.plantillas.listar(distributorId, query)).map(
        plantillaADto,
      ),
    };
  }

  @Post('templates')
  @Permiso('mensajes.configurar')
  @ApiOperation({ summary: 'Nueva respuesta guardada' })
  @ApiCreatedResponse({ type: CompanyTemplateResponseDto })
  @ApiBadRequestResponse({
    description:
      'Clave, título o texto inválidos, o variable desconocida (`TEMPLATE_VARIABLE_UNKNOWN`)',
  })
  @ApiConflictResponse({
    description:
      'Ya hay una vigente con esa clave (`MESSAGE_TEMPLATE_KEY_TAKEN`)',
  })
  async crearPlantilla(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Body() dto: CreateCompanyTemplateDto,
  ): Promise<CompanyTemplateResponseDto> {
    return plantillaADto(await this.plantillas.crear(distributorId, dto));
  }

  @Patch('templates/:id')
  @Permiso('mensajes.configurar')
  @ApiOperation({ summary: 'Cambiar una respuesta guardada' })
  @ApiOkResponse({ type: CompanyTemplateResponseDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, datos inválidos o variable desconocida (`TEMPLATE_VARIABLE_UNKNOWN`)',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  @ApiConflictResponse({
    description:
      'Ya hay una vigente con esa clave (`MESSAGE_TEMPLATE_KEY_TAKEN`)',
  })
  async actualizarPlantilla(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyTemplateDto,
  ): Promise<CompanyTemplateResponseDto> {
    return plantillaADto(
      await this.plantillas.actualizar(distributorId, id, dto),
    );
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('mensajes.configurar')
  @ApiOperation({
    summary: 'Dar de baja una respuesta guardada',
    description: 'Baja lógica: los mensajes que la usaron quedan igual.',
  })
  @ApiNoContentResponse({ description: 'Dada de baja' })
  @ApiBadRequestResponse({ description: 'Id que no es uuid' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  async bajaPlantilla(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.plantillas.darDeBaja(distributorId, id);
  }
}
