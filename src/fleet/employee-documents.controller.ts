import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { EmployeeDocumentsService } from './employee-documents.service';
import { EmployeeDocumentsResponseDto } from './dto/employee-documents-response.dto';
import { FleetTaskMapper } from './fleet-task.mapper';
import { FleetPlanMapper } from './fleet-plan.mapper';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

/**
 * La documentación de un empleado (CU-183 a CU-185, CU-187). Vive en `fleet`
 * porque las tareas y los planes son de este módulo; la ruta cuelga del legajo.
 */
@ApiTags('Personal · Documentación')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('employees')
export class EmployeeDocumentsController {
  constructor(private readonly documents: EmployeeDocumentsService) {}

  @Get(':id/documents')
  @ApiOperation({
    summary:
      'Documentación de un empleado: tarjetas, si queda inhabilitado y qué le falta cargar (CU-187)',
    description:
      'Las altas del curso de mercancías peligrosas, el psicofísico y la ART (CU-183 a CU-185) se hacen con `POST /fleet/tasks` indicando `employeeId`, el plan y el detalle.',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: EmployeeDocumentsResponseDto })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  async find(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<EmployeeDocumentsResponseDto> {
    const d = await this.documents.documentsOf(id, distributorId);
    const dto = new EmployeeDocumentsResponseDto();
    dto.employeeId = d.empleado.employeeId;
    dto.isLocked = d.isLocked;
    dto.lockReasons = d.lockReasons;
    dto.tasks = d.tasks.map((t) => FleetTaskMapper.toDto(t));
    dto.missingPlans = d.missingPlans.map((p) => FleetPlanMapper.toDto(p));
    return dto;
  }
}
