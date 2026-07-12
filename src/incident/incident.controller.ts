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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IncidentService } from './incident.service';
import { CreateIncidentDto } from './dto/create-incident.dto';
import { ResolveIncidentDto } from './dto/resolve-incident.dto';
import { Roles } from '../common/decorators/roles.decorator';
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
  @Roles(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Reportar una incidencia de entrega (chofer durante el reparto)',
  })
  @ApiResponse({ status: 201, description: 'Incidencia registrada' })
  @ApiResponse({ status: 404, description: 'Pedido no encontrado' })
  create(
    @Body() dto: CreateIncidentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.incidentService.create(dto, user.user_id);
  }

  @Get()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Listar incidencias (scopeado por distribuidora)' })
  findAll(@CurrentDistributor() distributorId: string | null) {
    return this.incidentService.findAll(distributorId);
  }

  @Get('order/:orderId')
  @Roles(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Incidencias de un pedido' })
  @ApiParam({ name: 'orderId', description: 'Order UUID' })
  findByOrder(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.incidentService.findByOrder(orderId, distributorId);
  }

  @Patch(':id/resolve')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Resolver una incidencia' })
  @ApiParam({ name: 'id', description: 'Incident UUID' })
  @ApiResponse({ status: 404, description: 'Incidencia no encontrada' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveIncidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.incidentService.resolve(id, dto, distributorId);
  }
}
