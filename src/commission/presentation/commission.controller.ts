import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CommissionQueryService } from '../application/commission-query.service';
import {
  CommissionEntryPageDto,
  MyCommissionsDto,
  QueryCommissionEntryDto,
  QueryMyCommissionsDto,
} from '../dto/commission.dto';
import { CommissionMapper } from './commission.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Libro de comisiones del chofer. */
@ApiTags('Comisiones · Asientos')
@Controller('commissions')
export class CommissionController {
  constructor(private readonly consultas: CommissionQueryService) {}

  @Get()
  @Permiso('finanzas.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Listar los asientos de comisión',
    description:
      'Comisiones por entrega y deducciones (faltantes de rendición). Filtra por chofer, tipo, período (días en hora argentina, inclusive) y si ya se liquidaron.',
  })
  @ApiOkResponse({ type: CommissionEntryPageDto })
  @ApiBadRequestResponse({ description: 'Período inválido' })
  async findAll(
    @Query() query: QueryCommissionEntryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CommissionEntryPageDto> {
    const r = await this.consultas.findAll(distributorId, query);
    return {
      data: r.data.map((a) => CommissionMapper.asiento(a)),
      total: r.total,
      totalAmount: r.totalAmount,
    };
  }

  @Get('mine')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Mis comisiones (chofer)',
    description:
      'Los asientos del propio chofer en el período, con lo pendiente de liquidar y lo ya liquidado.',
  })
  @ApiOkResponse({ type: MyCommissionsDto })
  @ApiNotFoundResponse({ description: 'El usuario no tiene perfil de chofer' })
  async mine(
    @Query() query: QueryMyCommissionsDto,
    @CurrentUser('user_id') userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MyCommissionsDto> {
    const r = await this.consultas.mias(userId, distributorId, query);
    return {
      data: r.data.map((a) => CommissionMapper.asiento(a)),
      total: r.total,
      totalAmount: r.totalAmount,
      pendingAmount: r.pendingAmount,
      liquidatedAmount: r.liquidatedAmount,
    };
  }
}
