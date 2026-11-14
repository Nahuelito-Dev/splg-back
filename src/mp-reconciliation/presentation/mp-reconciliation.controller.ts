import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBadGatewayResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { esSuperAdminDePlataforma } from '../../common/utils/alcance.util';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { DownloadLinkResponseDto } from '../../s3/dto/download-link.dto';
import { aEnlaceDeDescarga } from '../../s3/download-link';
import { MpReconciliationApplyService } from '../application/mp-reconciliation-apply.service';
import {
  MpContexto,
  MpReconciliationService,
} from '../application/mp-reconciliation.service';
import {
  ApplyMpReconciliationDto,
  CreateMpReconciliationDto,
  MpApplyResponseDto,
  MpReconciliationDetailResponseDto,
  MpReconciliationPageDto,
  MpReconciliationResponseDto,
  QueryMpReconciliationDto,
} from '../dto/mp-reconciliation.dto';
import { MpReconciliationMapper } from '../mp-reconciliation.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';
import {
  RequiereModulo,
  SinModulo,
} from '../../platform/access/requiere-modulo.decorator';

/**
 * Conciliación de la caja de Mercado Pago contra el reporte de liberaciones
 * (API v2). La cuenta de Mercado Pago es una sola para todo el sistema: cada
 * distribuidora concilia sólo los cobros suyos; los movimientos que no son de
 * ninguna (retiros, impuestos sueltos, cobros desconocidos) los ve y los
 * asienta únicamente el super admin.
 */
@RequiereModulo('mercadopago')
@ApiTags('Finanzas · Conciliación con Mercado Pago (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'mercadopago/reconciliations', version: '2' })
export class MpReconciliationController {
  constructor(
    private readonly conciliaciones: MpReconciliationService,
    private readonly aplicador: MpReconciliationApplyService,
  ) {}

  @Permiso('finanzas.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Pedir una conciliación con Mercado Pago',
    description:
      'Crea la corrida y le pide a Mercado Pago el reporte de liberaciones del rango (`from`..`to`, días argentinos inclusive, hasta 31 días, sin fechas futuras). El reporte es asíncrono: la corrida queda `requested` hasta que Mercado Pago lo genera (un proceso la revisa cada dos minutos y `GET /:id` también) y pasa a `ready` con las diferencias. Nada se asienta solo.',
  })
  @ApiCreatedResponse({ type: MpReconciliationResponseDto })
  @ApiBadRequestResponse({
    description: 'Rango inválido o rechazado por Mercado Pago',
  })
  @ApiConflictResponse({
    description: 'Ya hay una corrida pedida para ese rango',
  })
  @ApiBadGatewayResponse({
    description: 'Mercado Pago no respondió o rechazó la credencial',
  })
  async crear(
    @Body() dto: CreateMpReconciliationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MpReconciliationResponseDto> {
    const ctx = this.contexto(distributorId, user);
    return MpReconciliationMapper.corrida(
      await this.conciliaciones.crear(dto, ctx),
      this.veCuenta(ctx),
    );
  }

  @SinModulo(
    'Con Mercado Pago apagado la conciliación queda en sólo lectura hasta conciliar lo ya cobrado',
  )
  @Permiso('finanzas.ver')
  @Get()
  @ApiOperation({ summary: 'Corridas de conciliación de la distribuidora' })
  @ApiOkResponse({ type: MpReconciliationPageDto })
  async listar(
    @Query() query: QueryMpReconciliationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MpReconciliationPageDto> {
    const ctx = this.contexto(distributorId, user);
    const { data, total } = await this.conciliaciones.listar(ctx, query);
    return {
      data: data.map((c) =>
        MpReconciliationMapper.corrida(c, this.veCuenta(ctx)),
      ),
      total,
    };
  }

  @SinModulo(
    'Con Mercado Pago apagado la conciliación queda en sólo lectura hasta conciliar lo ya cobrado',
  )
  @Permiso('finanzas.ver')
  @Get(':id')
  @ApiOperation({
    summary: 'Una corrida con sus diferencias',
    description:
      'Si la corrida sigue esperando el reporte, antes de responder le pregunta a Mercado Pago. Las diferencias de la cuenta que no son de ninguna distribuidora (`accountLevel`) sólo las ve el super admin.',
  })
  @ApiParam({ name: 'id', description: 'Conciliación UUID' })
  @ApiOkResponse({ type: MpReconciliationDetailResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async detalle(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MpReconciliationDetailResponseDto> {
    const ctx = this.contexto(distributorId, user);
    const { corrida, items } = await this.conciliaciones.detalle(id, ctx);
    return MpReconciliationMapper.detalle(corrida, items, this.veCuenta(ctx));
  }

  @SinModulo(
    'Conciliar lo ya cobrado sigue con Mercado Pago apagado: es plata ya movida',
  )
  @Permiso('finanzas.gestionar')
  @Post(':id/apply')
  @Idempotent()
  @ApiOperation({
    summary: 'Asentar las diferencias elegidas',
    description:
      'Asienta en la caja de Mercado Pago los ajustes elegidos (`items`), cada uno una sola vez: una fila del reporte ya asentada, aunque sea desde otra corrida, no se repite. Cobros sin ingreso y comisiones pendientes usan las mismas referencias que `settle-pending`; impuestos, reintegros y devoluciones quedan como movimientos «Conciliación MP <fecha> — <descripción> (<id>)». Los retiros piden `cashBoxId` (la caja que recibió el dinero). Las diferencias de la cuenta (retiros, impuestos sueltos) sólo las asienta el super admin, indicando `distributorId` (la de la corrida), y se asientan una sola vez en todo el sistema. Cada ajuste va en su transacción: uno rechazado por la caja no frena a los demás y aparece en `results`.',
  })
  @ApiParam({ name: 'id', description: 'Conciliación UUID' })
  @ApiOkResponse({ type: MpApplyResponseDto })
  @ApiBadRequestResponse({
    description:
      'Una diferencia no se puede asentar desde acá o falta la caja de destino',
  })
  @ApiNotFoundResponse({
    description: 'La corrida o alguna diferencia no existe',
  })
  @ApiConflictResponse({
    description:
      'La corrida no está lista o falta configurar la caja de Mercado Pago',
  })
  aplicar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyMpReconciliationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MpApplyResponseDto> {
    return this.aplicador.aplicar(id, dto, this.contexto(distributorId, user));
  }

  @SinModulo(
    'Con Mercado Pago apagado la conciliación queda en sólo lectura hasta conciliar lo ya cobrado',
  )
  @Permiso('finanzas.ver')
  @Get(':id/report')
  @ApiOperation({
    summary: 'Bajar el reporte de liberaciones',
    description:
      'Enlace firmado `{ url, expiresAt, requiresAuth }` al CSV de Mercado Pago, que es el comprobante de los movimientos. La distribuidora baja el archivo filtrado a sus cobros; el super admin que pidió la corrida baja el completo de la cuenta.',
  })
  @ApiParam({ name: 'id', description: 'Conciliación UUID' })
  @ApiOkResponse({ type: DownloadLinkResponseDto })
  @ApiNotFoundResponse({
    description: 'No existe o todavía no tiene el reporte guardado',
  })
  async reporte(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DownloadLinkResponseDto> {
    return aEnlaceDeDescarga(
      await this.conciliaciones.enlaceDelReporte(
        id,
        this.contexto(distributorId, user),
      ),
    );
  }

  /**
   * En modo soporte el super admin ve la conciliación como un admin de la
   * empresa: sin los movimientos de la cuenta entera ni su reporte completo.
   */
  private contexto(distributorId: string, user: AuthenticatedUser): MpContexto {
    return {
      distributorId,
      userId: user.user_id,
      role:
        user.role === RoleType.SUPER_ADMIN && !esSuperAdminDePlataforma(user)
          ? RoleType.ADMIN
          : user.role,
    };
  }

  private veCuenta(ctx: MpContexto): boolean {
    return ctx.role === RoleType.SUPER_ADMIN;
  }
}
