import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CashBoxService } from '../application/cash-box.service';
import { CashMovementService } from '../application/cash-movement.service';
import { CashSessionService } from '../application/cash-session.service';
import { CashMapper } from '../cash.mapper';
import {
  CashSessionDetailDto,
  CashSessionResponseDto,
  CloseCashSessionDto,
} from '../dto/cash-session.dto';
import { CashDirection } from '../domain/cash.enums';
import { sumar } from '../../common/utils/dinero';
import { aCentavos } from '../../common/utils/dinero';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Sesiones de caja: ver y cerrar con arqueo (CU-227). */
@ApiTags('Finanzas · Cajas')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('cash-sessions')
export class CashSessionController {
  constructor(
    private readonly sesiones: CashSessionService,
    private readonly movimientos: CashMovementService,
    private readonly cajas: CashBoxService,
  ) {}

  @Permiso('finanzas.ver')
  @Get(':id')
  @ApiOperation({
    summary: 'Ver una sesión con sus movimientos',
    description:
      'Monto inicial, movimientos de la sesión y saldo actual de la caja: lo que se ve antes de cerrar con el arqueo.',
  })
  @ApiParam({ name: 'id', description: 'Sesión UUID' })
  @ApiOkResponse({ type: CashSessionDetailDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CashSessionDetailDto> {
    const { sesion, cashBoxName } = await this.sesiones.findOne(
      id,
      distributorId,
    );
    const crudos = await this.sesiones.movimientosDe(id);
    const conNombres = await this.movimientos.conNombres(crudos);
    const { caja } = await this.cajas.findOne(sesion.cashBoxId, distributorId);
    const suma = (d: CashDirection) =>
      aCentavos(
        sumar(crudos.filter((m) => m.direction === d).map((m) => m.amount)),
      );
    return CashMapper.sesionConDetalle(sesion, cashBoxName, {
      currentBalance: caja.balance,
      totalIn: suma(CashDirection.IN),
      totalOut: suma(CashDirection.OUT),
      movements: conNombres.map((m) => CashMapper.movimiento(m.movimiento, m)),
    });
  }

  @Permiso('finanzas.gestionar')
  @Patch(':id/close')
  @Idempotent()
  @ApiOperation({
    summary: 'Cerrar la caja con arqueo',
    description:
      'Esperado = apertura + entradas − salidas de la sesión. Si lo contado difiere se asienta un ajuste ("sobrante" o "faltante de caja") para que el saldo quede igual a lo contado.',
  })
  @ApiParam({ name: 'id', description: 'Sesión UUID' })
  @ApiOkResponse({ type: CashSessionResponseDto })
  @ApiBadRequestResponse({ description: 'Monto contado negativo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'La sesión ya está cerrada' })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseCashSessionDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CashSessionResponseDto> {
    const s = await this.sesiones.cerrar(id, dto, distributorId, userId);
    return CashMapper.sesion(s.sesion, s.cashBoxName);
  }
}
