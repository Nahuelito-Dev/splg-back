import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import {
  QueryRepurchaseForecastDto,
  QueryRepurchaseInvitationsDto,
  QueryRepurchaseStatsDto,
  RunRepurchaseDto,
} from './dto/repurchase-request.dto';
import {
  AdminInvitationPageDto,
  RepurchaseCustomerForecastDto,
  RepurchaseForecastPageDto,
  RepurchaseRunResponseDto,
  RepurchaseStatsResponseDto,
} from './dto/repurchase-response.dto';
import { RepurchaseForecastService } from './repurchase-forecast.service';
import { RepurchaseMapper } from './repurchase.mapper';
import { RepurchaseReportService } from './repurchase-report.service';
import { Permiso } from '../common/decorators/permiso.decorator';
import { RequiereModulo } from '../platform/access/requiere-modulo.decorator';

const FALTA_DISTRIBUIDORA =
  'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")';

/**
 * Recompra anticipada (CU-106, módulo inteligente M3), lado del administrador:
 * a quién se le acaba el gas (CU-146), las invitaciones que el sistema emitió y
 * cómo les fue. Los parámetros del proceso son los de
 * `GET|PUT /module-config/repurchase` (CU-172).
 */
@RequiereModulo('repurchase')
@ApiTags('Repurchase (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'repurchase', version: '2' })
export class RepurchaseAdminController {
  constructor(
    private readonly report: RepurchaseReportService,
    private readonly forecast: RepurchaseForecastService,
  ) {}

  @Permiso('reportes.ver')
  @Get('forecast')
  @ApiOperation({
    summary: 'Clientes a los que se les acaba el gas (CU-146)',
    description:
      'Los clientes de la distribuidora cuya fecha estimada de recompra cae dentro de `days` días (por omisión 14), del más próximo al más lejano, con su última compra, su consumo declarado y de dónde sale la estimación (`history`: sus compras; `declared`: el consumo que declaró). Los que ya se pasaron de la fecha y siguen proyectados aparecen con `daysLeft` negativo. No aparecen los que nunca le compraron a la distribuidora, los que no tienen con qué estimarlos ni los que dejaron de comprar.',
  })
  @ApiOkResponse({ type: RepurchaseForecastPageDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async proximas(
    @Query() query: QueryRepurchaseForecastDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RepurchaseForecastPageDto> {
    const ahora = new Date();
    const dias = query.days ?? 14;
    const { filas, total } = await this.report.proximas(
      distributorId,
      dias,
      { limit: query.limit ?? 20, offset: query.offset ?? 0 },
      ahora,
    );
    return {
      data: filas.map((f) =>
        RepurchaseMapper.forecastRow(f.cliente, ahora, f.abierta),
      ),
      total,
      days: dias,
      generatedAt: ahora,
    };
  }

  @Permiso('reportes.ver')
  @Get('forecast/customers/:userId')
  @ApiOperation({
    summary: 'La fecha estimada de recompra de un cliente',
    description:
      'Para la ficha del cliente. Sin estimación (`forecast: null`) explica por qué en `reason`.',
  })
  @ApiParam({ name: 'userId', description: 'User UUID del cliente' })
  @ApiOkResponse({ type: RepurchaseCustomerForecastDto })
  @ApiNotFoundResponse({ description: 'No es cliente de la distribuidora' })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  async delCliente(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RepurchaseCustomerForecastDto> {
    const ahora = new Date();
    const { evaluacion, abierta } = await this.report.delCliente(
      distributorId,
      userId,
      ahora,
    );
    return {
      forecast: evaluacion.cliente
        ? RepurchaseMapper.forecastRow(evaluacion.cliente, ahora, abierta)
        : null,
      reason: evaluacion.reason,
    };
  }

  @Permiso('reportes.ver')
  @Get('invitations')
  @ApiOperation({
    summary: 'Invitaciones de recompra emitidas',
    description:
      'Las invitaciones de la distribuidora, la más nueva primero, con el cliente y cómo terminó cada una (`pending`, `accepted`, `rejected`, `expired` o `cancelled`).',
  })
  @ApiOkResponse({ type: AdminInvitationPageDto })
  @ApiBadRequestResponse({
    description: `from o to inválidos, o from posterior a to. ${FALTA_DISTRIBUIDORA}`,
  })
  async invitaciones(
    @Query() query: QueryRepurchaseInvitationsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<AdminInvitationPageDto> {
    const [invitaciones, total] = await this.report.listar(
      distributorId,
      query,
    );
    return {
      data: invitaciones.map((i) => RepurchaseMapper.adminInvitation(i)),
      total,
    };
  }

  @Permiso('reportes.ver')
  @Get('stats')
  @ApiOperation({
    summary: 'Cómo le va a la recompra anticipada',
    description:
      'Invitaciones del período por resultado y la tasa de conversión: aceptadas sobre las que ya tuvieron resolución (aceptadas, descartadas y vencidas; las abiertas y las canceladas por compra propia no cuentan). `accuracy` mide cuánto acertó la fecha proyectada contra la primera compra entregada después de cada invitación. Por omisión, los últimos 90 días.',
  })
  @ApiOkResponse({ type: RepurchaseStatsResponseDto })
  @ApiBadRequestResponse({
    description: `from o to inválidos, o from posterior a to. ${FALTA_DISTRIBUIDORA}`,
  })
  async stats(
    @Query() query: QueryRepurchaseStatsDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RepurchaseStatsResponseDto> {
    const { resumen, accuracy, desde, hasta } = await this.report.resumen(
      distributorId,
      query.from,
      query.to,
      new Date(),
    );
    return RepurchaseMapper.stats(resumen, desde, hasta, accuracy);
  }

  @Permiso('reportes.ver')
  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Correr la anticipación de recompra ahora',
    description:
      'Hace lo que el proceso diario para esta distribuidora: vence las invitaciones sin respuesta y abre una a cada cliente al que se le acaba el gas dentro de su anticipación, sin pedido vigente ni invitación reciente. Es idempotente y respeta el interruptor `enabled` del proceso (viene apagado: 409). Con `dryRun: true` sólo calcula a quién se invitaría, sin escribir ni avisar a nadie.',
  })
  @ApiOkResponse({ type: RepurchaseRunResponseDto })
  @ApiBadRequestResponse({ description: FALTA_DISTRIBUIDORA })
  @ApiConflictResponse({
    description:
      'La anticipación está apagada (`enabled` en 0 de `/module-config/repurchase`); la simulación con `dryRun` funciona igual',
  })
  async correr(
    @Body() dto: RunRepurchaseDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<RepurchaseRunResponseDto> {
    return RepurchaseMapper.run(
      await this.forecast.ejecutar(distributorId, new Date(), {
        dryRun: dto.dryRun,
      }),
    );
  }
}
