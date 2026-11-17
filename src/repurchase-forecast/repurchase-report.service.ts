import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  diaArgentino,
  rangoDeDiasArgentinos,
  sumarDias,
} from '../common/utils/dias-argentina';
import {
  AciertoDePrediccion,
  errorEnDias,
  resumirAcierto,
} from '../common/utils/acierto-de-prediccion';
import { RepurchaseInvitation } from './entities/repurchase-invitation.entity';
import {
  EvaluacionDeCliente,
  RecompraEstimada,
  RepurchaseEstimatorService,
} from './repurchase-estimator.service';
import {
  RepurchaseInvitationService,
  ResumenDeInvitaciones,
} from './repurchase-invitation.service';
import { QueryRepurchaseInvitationsDto } from './dto/repurchase-request.dto';

const MS_POR_DIA = 86_400_000;
const DIAS_POR_OMISION = 90;
/** Una compra dentro de estos días de la fecha proyectada cuenta como acierto. */
export const MARGEN_DE_ACIERTO_DIAS = 3;

export interface ProximasRecompras {
  filas: Array<{
    cliente: RecompraEstimada;
    abierta: RepurchaseInvitation | null;
  }>;
  total: number;
}

/**
 * Las lecturas del administrador sobre la recompra anticipada (CU-146): a quién
 * se le acaba el gas, las invitaciones y cómo les fue.
 */
@Injectable()
export class RepurchaseReportService {
  constructor(
    private readonly estimator: RepurchaseEstimatorService,
    private readonly invitaciones: RepurchaseInvitationService,
  ) {}

  /** Los clientes a los que se les acaba el gas dentro de `dias`, del más próximo al más lejano. */
  async proximas(
    distributorId: string,
    dias: number,
    pagina: { limit: number; offset: number },
    ahora: Date,
  ): Promise<ProximasRecompras> {
    const params = await this.estimator.parametros(distributorId);
    const estimadas = await this.estimator.estimar(
      distributorId,
      ahora,
      params,
    );
    const limite = ahora.getTime() + dias * MS_POR_DIA;
    const enVentana = estimadas.filter(
      (e) => e.estimate.estimatedAt.getTime() <= limite,
    );
    const pagina_ = enVentana.slice(
      pagina.offset,
      pagina.offset + pagina.limit,
    );
    const abiertas = await this.invitaciones.abiertasDe(
      distributorId,
      pagina_.map((e) => e.userId),
    );
    return {
      total: enVentana.length,
      filas: pagina_.map((cliente) => ({
        cliente,
        abierta: abiertas.get(cliente.userId) ?? null,
      })),
    };
  }

  /** La estimación de un cliente de la distribuidora; 404 si no es de ella. */
  async delCliente(
    distributorId: string,
    userId: string,
    ahora: Date,
  ): Promise<{
    evaluacion: EvaluacionDeCliente;
    abierta: RepurchaseInvitation | null;
  }> {
    const params = await this.estimator.parametros(distributorId);
    const evaluacion = await this.estimator.estimarCliente(
      distributorId,
      userId,
      ahora,
      params,
    );
    if (!evaluacion) throw new NotFoundException('Cliente no encontrado');
    const abiertas = await this.invitaciones.abiertasDe(distributorId, [
      userId,
    ]);
    return { evaluacion, abierta: abiertas.get(userId) ?? null };
  }

  async listar(
    distributorId: string,
    query: QueryRepurchaseInvitationsDto,
  ): Promise<[RepurchaseInvitation[], number]> {
    const { desde, hasta } = this.rango(query.from, query.to, null);
    return this.invitaciones.listar(distributorId, {
      status: query.status,
      userId: query.userId,
      from: query.from ? desde : undefined,
      to: query.to ? hasta : undefined,
      limit: query.limit ?? 10,
      offset: query.offset ?? 0,
    });
  }

  async resumen(
    distributorId: string,
    from: string | undefined,
    to: string | undefined,
    ahora: Date,
  ): Promise<{
    resumen: ResumenDeInvitaciones;
    accuracy: AciertoDePrediccion;
    desde: Date;
    hasta: Date;
  }> {
    const { desde, hasta } = this.rango(from, to, ahora);
    const compras = await this.invitaciones.comprasPosteriores(
      distributorId,
      desde,
      hasta,
    );
    return {
      resumen: await this.invitaciones.resumen(distributorId, desde, hasta),
      accuracy: resumirAcierto(
        compras.map((c) => errorEnDias(c.predicha, c.real)),
        MARGEN_DE_ACIERTO_DIAS,
      ),
      desde,
      hasta,
    };
  }

  /** El período `[desde, hasta)` en instantes: los días son argentinos y `to` es inclusivo. */
  private rango(
    from: string | undefined,
    to: string | undefined,
    ahora: Date | null,
  ): { desde: Date; hasta: Date } {
    const hoy = diaArgentino(ahora ?? new Date());
    const diaDesde = from ?? sumarDias(hoy, -DIAS_POR_OMISION);
    const diaHasta = to ?? hoy;
    const rango = rangoDeDiasArgentinos(diaDesde, diaHasta);
    if (!rango) {
      throw new BadRequestException('from y to tienen que ser YYYY-MM-DD');
    }
    if (diaDesde > diaHasta) {
      throw new BadRequestException('from no puede ser posterior a to');
    }
    return rango;
  }
}
