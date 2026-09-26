import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { AuditMapper } from './audit.mapper';
import { ConsultarAuditoriaDto } from './dto/consultar-auditoria.dto';
import { RegistroDeAuditoriaDto } from './dto/audit-log-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * CU-152. El registro es de sólo lectura por la API: no hay alta, edición
   * ni baja de asientos (los escribe el sistema, CU-153).
   */
  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Consultar el registro de auditoría',
    description:
      'Quién hizo cada operación que modificó datos, sobre qué, cuándo, desde ' +
      'qué aplicación y con qué resultado. Un admin de empresa ve sólo lo de ' +
      'su distribuidora.',
  })
  @ApiOkResponse({ type: RegistroDeAuditoriaDto })
  async consultar(
    @Query() filtros: ConsultarAuditoriaDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<RegistroDeAuditoriaDto> {
    const { items, total } = await this.auditService.consultar(
      filtros,
      distributorId,
    );
    return { items: items.map((a) => AuditMapper.toDto(a)), total };
  }
}
