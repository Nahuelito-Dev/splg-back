import type { Response } from 'express';
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { VehicleAssignmentMapper } from './vehicle-assignment.mapper';
import { VehicleAssignmentHistoryResponseDto } from './dto/vehicle-assignment-response.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { ApiTotal, informarTotal } from '../common/http/total';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

/**
 * Historial de choferes de un vehículo. Vive en `fleet`, no en `car`, igual
 * que `CarDocumentsController`: la ruta HTTP no depende de en qué módulo se
 * declara el controller.
 */
@ApiTags('Fleet · Vehicle in use')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('car')
export class CarAssignmentsController {
  constructor(private readonly vehicleAssignments: VehicleAssignmentService) {}

  @Get(':id/assignments')
  @ApiOperation({ summary: 'Historial de choferes que usaron un vehículo' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiOkResponse({ type: VehicleAssignmentHistoryResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Vehículo no encontrado' })
  @ApiTotal()
  async historial(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAssignmentHistoryResponseDto[]> {
    const [filas, total] = await this.vehicleAssignments.historialDelVehiculo(
      id,
      distributorId,
      pagination,
    );
    informarTotal(res, total);
    return filas.map((f) => VehicleAssignmentMapper.toHistoryDto(f));
  }
}
