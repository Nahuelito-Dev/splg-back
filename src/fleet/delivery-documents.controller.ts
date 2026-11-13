import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { FleetTaskService } from './fleet-task.service';
import { FleetTaskMapper } from './fleet-task.mapper';
import { FleetDriverDocumentsResponseDto } from './dto/documents-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Fachada de sólo lectura, para el panel de un chofer (CU-138). Vive en
 * `fleet` (no en `delivery`) para no tocar ese módulo: la ruta HTTP no
 * depende de en qué módulo de Nest se declara el controller.
 */
@ApiTags('Fleet · Driver documents')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('delivery/:id/documents')
export class DeliveryDocumentsController {
  constructor(private readonly tasksService: FleetTaskService) {}

  @Permiso('personal.ver')
  @Get()
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o super admin sin X-Distributor',
  })
  @ApiOperation({
    summary: 'Documentación de un chofer (licencia) y si está inhabilitado',
  })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({ type: FleetDriverDocumentsResponseDto })
  @ApiNotFoundResponse({ description: 'Chofer no encontrado' })
  async findAll(
    @Param('id', ParseUUIDPipe) deliveryId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetDriverDocumentsResponseDto> {
    const { tasks, isLocked } = await this.tasksService.listByDelivery(
      deliveryId,
      distributorId,
    );

    const dto = new FleetDriverDocumentsResponseDto();
    dto.deliveryId = deliveryId;
    dto.isLocked = isLocked;
    dto.tasks = tasks.map((t) => FleetTaskMapper.toDto(t));
    return dto;
  }
}
