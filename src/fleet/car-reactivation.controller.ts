import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CarMapper } from '../car/car.mapper';
import { CarPhotoService } from '../car/car-photo.service';
import { CarResponseDto } from '../car/dto/car-response.dto';
import { FleetVehicleStatusService } from './fleet-vehicle-status.service';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

/** Reactivar un vehículo fuera de servicio (CU-247). Vive en `fleet`, que es quien conoce la documentación. */
@ApiTags('Fleet · Vehicle status')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('car')
export class CarReactivationController {
  constructor(
    private readonly status: FleetVehicleStatusService,
    private readonly carPhoto: CarPhotoService,
  ) {}

  @Permiso('flota.gestionar')
  @Post(':id/reactivate')
  @ApiOperation({
    summary: 'Reactivar un vehículo fuera de servicio',
    description:
      'Lo pasa de `grounded` a `active` si el seguro, la VTV y la habilitación de mercancías peligrosas están vigentes. No lo asigna a ningún chofer.',
  })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiOkResponse({ type: CarResponseDto })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  @ApiConflictResponse({ description: 'El vehículo no está fuera de servicio' })
  @ApiBadRequestResponse({
    description: 'Hay documentación bloqueante vencida: el detalle dice cuál',
  })
  async reactivar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarResponseDto> {
    const car = await this.status.reactivar(id, distributorId);
    await this.carPhoto.firmar(car);
    return CarMapper.toDto(car);
  }
}
