import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { RequiereModulo } from '../../platform/access/requiere-modulo.decorator';
import { CylinderRecoveryCasesService } from './cylinder-recovery-cases.service';
import { RecoveryCustomerScoreDto } from './dto/recovery-response.dto';

/**
 * Puntaje de riesgo de recupero de un cliente (M5, API v3): cuánto se demoró en
 * devolver envases y qué plazos le rigen por eso. Sólo lo ve el administrador.
 */
@RequiereModulo('cylinder_recovery')
@ApiTags('Cylinders · Recovery (v3)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'cylinder-recovery', version: '3' })
export class CylinderRecoveryScoreController {
  constructor(private readonly cases: CylinderRecoveryCasesService) {}

  @Get('customers/:customerId/score')
  @Permiso('stock.ver')
  @ApiOperation({
    summary: 'Puntaje de riesgo de recupero de un cliente',
    description:
      'Casos demorados históricos sobre pedidos entregados, suavizado hacia un valor neutro, con su banda (`low`, `medium`, `high`) y los plazos de tolerancia y de escalón que le rigen. Un cliente sin casos tiene puntaje neutro (`neutral: true`, banda media). El puntaje cambia cuándo se avisa, nunca los importes.',
  })
  @ApiParam({ name: 'customerId', description: 'User UUID del cliente' })
  @ApiOkResponse({ type: RecoveryCustomerScoreDto })
  @ApiBadRequestResponse({
    description:
      'El identificador no es válido o super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")',
  })
  @ApiForbiddenResponse({
    description:
      'Rol sin acceso o el módulo de recupero no está habilitado para la distribuidora',
  })
  @ApiNotFoundResponse({
    description: 'El cliente no existe o es de otra distribuidora',
  })
  puntaje(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RecoveryCustomerScoreDto> {
    return this.cases.puntajeDelCliente(customerId, distributorId);
  }
}
