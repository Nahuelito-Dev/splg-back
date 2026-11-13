import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { FleetTaskService } from './fleet-task.service';
import { FleetTaskMapper } from './fleet-task.mapper';
import { FleetVehicleDocumentsResponseDto } from './dto/documents-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Fachada de sólo lectura, para el panel de un vehículo (CU-136/137). Vive en
 * `fleet` (no en `car`) para no tocar ese módulo: la ruta HTTP no depende de
 * en qué módulo de Nest se declara el controller.
 */
@ApiTags('Fleet · Vehicle documents')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('cars/:carId/documents')
export class CarDocumentsController {
  constructor(private readonly tasksService: FleetTaskService) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({
    summary:
      'Documentación de un vehículo (seguro, VTV, services) y si está inhabilitado',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiOkResponse({ type: FleetVehicleDocumentsResponseDto })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  async findAll(
    @Param('carId', ParseUUIDPipe) carId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetVehicleDocumentsResponseDto> {
    const { tasks, isLocked } = await this.tasksService.listByCar(
      carId,
      distributorId,
    );

    const dto = new FleetVehicleDocumentsResponseDto();
    dto.carId = carId;
    dto.isLocked = isLocked;
    dto.tasks = tasks.map((t) => FleetTaskMapper.toDto(t));
    return dto;
  }
}
