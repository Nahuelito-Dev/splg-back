import { Args, Query, Resolver } from '@nestjs/graphql';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { comparativoDeVentas } from './comparativo-de-ventas';
import { EvolucionDeVentasDto } from './dto/report-response.dto';
import {
  ComparativoDeVentasDto,
  VentasPorChoferV2Dto,
  VentasPorMedioDePagoV2Dto,
  VentasPorProductoV2Dto,
} from './dto/report-v2.dto';
import {
  EvolucionDeVentasArgs,
  Granularity,
  RangoDelInformeArgs,
  ResumenDeVentasArgs,
} from './graphql/reportes.args';
import { rangoDelInforme } from './rango-del-informe';
import { ReportsService } from './reports.service';

/**
 * Cuánto pesa cada informe en el límite de complejidad de una consulta: cada
 * uno es una consulta a la base (y una vuelta por los guards), así que pesa
 * bastante más que un campo suelto (1).
 */
export const COMPLEJIDAD_DE_UN_INFORME = 10;

const NOTA_VENTAS =
  'Mismos criterios que la API REST: días en hora argentina, `to` inclusivo, sólo lo COBRADO.';

/**
 * Informes de ventas por GraphQL (`/api/graphql`), sólo lectura. Son los
 * mismos que `GET /v2/reports/*` y `GET /reports/sales-evolution`: el mismo
 * servicio, el mismo rango y las mismas validaciones, y la misma seguridad
 * (guards globales de token, rol, permiso, modo soporte y distribuidora, que
 * leen la request del contexto de GraphQL).
 */
@Resolver()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
export class ReportsResolver {
  constructor(private readonly reports: ReportsService) {}

  @Permiso('reportes.ver')
  @Query(() => ComparativoDeVentasDto, {
    name: 'salesSummary',
    complexity: COMPLEJIDAD_DE_UN_INFORME,
    description: `Ventas, pedidos y ticket promedio del rango y del período inmediato anterior. ${NOTA_VENTAS}`,
  })
  resumenDeVentas(
    @Args() args: ResumenDeVentasArgs,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<ComparativoDeVentasDto> {
    return comparativoDeVentas(args.from, args.to, args.compare, (s, e) =>
      this.reports.getSalesSummary(s, e, distributorId),
    );
  }

  @Permiso('reportes.ver')
  @Query(() => VentasPorChoferV2Dto, {
    name: 'salesByDriver',
    complexity: COMPLEJIDAD_DE_UN_INFORME,
    description: `Ventas por chofer, de mayor a menor, con los totales. ${NOTA_VENTAS}`,
  })
  ventasPorChofer(
    @Args() args: RangoDelInformeArgs,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorChoferV2Dto> {
    const { startDate, endDate } = rangoDelInforme(args.from, args.to);
    return this.reports.getSalesByDriverConTotales(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Permiso('reportes.ver')
  @Query(() => VentasPorProductoV2Dto, {
    name: 'salesByProduct',
    complexity: COMPLEJIDAD_DE_UN_INFORME,
    description: `Ventas por producto (subtotales de los renglones, sin recargos), de mayor a menor, con los totales. ${NOTA_VENTAS}`,
  })
  ventasPorProducto(
    @Args() args: RangoDelInformeArgs,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorProductoV2Dto> {
    const { startDate, endDate } = rangoDelInforme(args.from, args.to);
    return this.reports.getSalesByProductConTotales(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Permiso('reportes.ver')
  @Query(() => VentasPorMedioDePagoV2Dto, {
    name: 'salesByPayment',
    complexity: COMPLEJIDAD_DE_UN_INFORME,
    description: `Ventas por medio de pago, de mayor a menor, con los totales. ${NOTA_VENTAS}`,
  })
  ventasPorMedioDePago(
    @Args() args: RangoDelInformeArgs,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<VentasPorMedioDePagoV2Dto> {
    const { startDate, endDate } = rangoDelInforme(args.from, args.to);
    return this.reports.getSalesByPaymentMethodConTotales(
      startDate,
      endDate,
      distributorId,
    );
  }

  @Permiso('reportes.ver')
  @Query(() => [EvolucionDeVentasDto], {
    name: 'salesEvolution',
    complexity: COMPLEJIDAD_DE_UN_INFORME,
    description: `Ventas por período (día, semana o mes), por fecha de entrega y con el total del pedido (con recargos). ${NOTA_VENTAS}`,
  })
  evolucionDeVentas(
    @Args() args: EvolucionDeVentasArgs,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<EvolucionDeVentasDto[]> {
    const { startDate, endDate } = rangoDelInforme(args.from, args.to);
    return this.reports.getSalesEvolution(
      startDate,
      endDate,
      GRANULARIDAD_SQL[args.granularity ?? Granularity.DAY],
      distributorId,
    );
  }
}

const GRANULARIDAD_SQL: Record<Granularity, 'day' | 'week' | 'month'> = {
  [Granularity.DAY]: 'day',
  [Granularity.WEEK]: 'week',
  [Granularity.MONTH]: 'month',
};
