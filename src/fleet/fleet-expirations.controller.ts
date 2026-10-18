import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FleetExpirationsService } from './fleet-expirations.service';
import { FleetExpirationsQueryDto } from './dto/expirations-query.dto';
import { FleetExpirationsResponseDto } from './dto/expirations-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Fleet · Expirations')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('fleet/expirations')
export class FleetExpirationsController {
  constructor(private readonly expirations: FleetExpirationsService) {}

  @Get()
  @ApiOperation({
    summary:
      'CU-139 y CU-187: vencimientos de la flota y del personal en una pantalla',
    description:
      'Lo vencido y lo que vence dentro de `withinDays`, agrupado por vehículo, por chofer (histórico) y por empleado, con si están inhabilitados. `subject` y `category` acotan qué trae.',
  })
  @ApiOkResponse({ type: FleetExpirationsResponseDto })
  async find(
    @Query() query: FleetExpirationsQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetExpirationsResponseDto> {
    return this.expirations.find(distributorId, query);
  }
}
