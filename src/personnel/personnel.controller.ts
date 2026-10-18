import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PersonnelDashboardService } from './personnel-dashboard.service';
import { PersonnelDashboardDto } from './dto/personnel-dashboard.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Personal · Tablero')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('personnel')
export class PersonnelController {
  constructor(private readonly dashboard: PersonnelDashboardService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Consultar el tablero de personal (CU-194)',
    description:
      'Empleados activos por puesto, presentes hoy (jornada abierta), de licencia hoy (licencia aprobada que cubre el día argentino) y documentos por estado de vencimiento. Alimenta la tarjeta «Personal hoy» del inicio. Cuenta; no lista.',
  })
  @ApiOkResponse({ type: PersonnelDashboardDto })
  consultar(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<PersonnelDashboardDto> {
    return this.dashboard.consultar(distributorId);
  }
}
