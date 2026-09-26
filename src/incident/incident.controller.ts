import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { IncidentService } from './incident.service';
import { IncidentMapper } from './incident.mapper';
import { IncidentResponseDto } from './dto/incident-response.dto';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { ResolveIncidentDto } from './dto/resolve-incident.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Incidents')
@ApiBearerAuth()
@Controller('incidents')
export class IncidentController {
  constructor(private readonly incidentService: IncidentService) {}

  @Post()
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Reportar una incidencia de entrega (chofer durante el reparto)',
  })
  @ApiCreatedResponse({ type: IncidentResponseDto })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: orderId must be a UUID; type must be one of the following values: damaged, out_of_stock, no_show, other)',
  })
  async create(
    @Body() dto: CreateIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto> {
    return IncidentMapper.toDto(
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
    return incidents.map((i) => IncidentMapper.toDto(i));
  }

  @Get('order/:orderId')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Incidencias de un pedido' })
  @ApiParam({ name: 'orderId', description: 'Order UUID' })
  @ApiOkResponse({ type: IncidentResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  async findByOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<IncidentResponseDto[]> {
    const incidents = await this.incidentService.findByOrder(
      orderId,
      distributorId,
    );
    return incidents.map((i) => IncidentMapper.toDto(i));
  }

  @Patch(':id/resolve')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Resolver una incidencia' })
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiOkResponse({ type: IncidentResponseDto })
  @ApiNotFoundResponse({ description: 'Incidencia no encontrada' })
  @ApiBadRequestResponse({
    description: 'Datos inválidos (p. ej.: resolutionNote must be a string)',
  })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveIncidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<IncidentResponseDto> {
    return IncidentMapper.toDto(
      await this.incidentService.resolve(id, dto, distributorId),
    );
  }
}
