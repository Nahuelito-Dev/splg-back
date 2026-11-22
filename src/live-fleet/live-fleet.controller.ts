import { Controller, Get } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { LiveFleetDto } from './dto/live-fleet-response.dto';
import { LiveFleetService } from './live-fleet.service';

/** Seguimiento en vivo del panel: los vehículos que están en la calle ahora. */
@ApiTags('Tracking (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'tracking', version: '2' })
export class LiveFleetController {
  constructor(private readonly liveFleet: LiveFleetService) {}

  @Permiso('pedidos.ver', 'despacho.gestionar')
  @Get('vehicles')
  @ApiOperation({
    summary: 'Vehículos en uso ahora',
    description:
      'Los vehículos que un chofer tiene en uso en este momento, cada uno con su chofer (nombre, teléfono y foto), la ocupación (envases a bordo sobre la capacidad en garrafas, en por ciento), la carga abierta, la hoja de ruta de hoy de ese chofer con ese vehículo (avance y llegada estimada a la última parada), las paradas en su orden más los pedidos en curso fuera de una hoja, y la última posición conocida. `status` es `on_route` si la hoja ya se inició o hay un pedido aceptado o en camino, y `waiting` si no. Sólo lectura (sirve en modo soporte). Las fotos son URL firmadas de corta vigencia, o `null`. En vivo: `order:driver-location` y `route-sheet:*` en el socket del panel.',
  })
  @ApiOkResponse({ type: LiveFleetDto })
  @ApiBadRequestResponse({
    description: 'Falta la distribuidora (super admin sin X-Distributor)',
  })
  vehiculos(
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<LiveFleetDto> {
    return this.liveFleet.vehiculos(distributorId);
  }
}
