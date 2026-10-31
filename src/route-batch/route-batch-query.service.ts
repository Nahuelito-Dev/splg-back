import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { DeliveryService } from '../delivery/delivery.service';
import { Delivery } from '../delivery/entities/delivery.entity';
import {
  RouteBatch,
  RouteBatchStatus,
} from '../order/entities/route-batch.entity';
import { RouteBatchOffer } from '../order/entities/route-batch-offer.entity';
import { RouteBatchStop } from '../order/entities/route-batch-stop.entity';
import {
  DriverRouteBatchResponseDto,
  RouteBatchPageDto,
  RouteBatchResponseDto,
} from './dto/route-batch-response.dto';
import { ChoferesDelLote, RouteBatchMapper } from './route-batch.mapper';

const RELACIONES_DE_LA_PARADA = {
  order: {
    address: true,
    timeSlot: true,
    customer: true,
    items: { gasCylinder: true },
  },
} as const;

/** Lecturas de los lotes: el panel del administrador y la app del chofer. */
@Injectable()
export class RouteBatchQueryService {
  constructor(
    @InjectRepository(RouteBatch)
    private readonly batches: Repository<RouteBatch>,
    @InjectRepository(RouteBatchStop)
    private readonly stops: Repository<RouteBatchStop>,
    @InjectRepository(RouteBatchOffer)
    private readonly offers: Repository<RouteBatchOffer>,
    private readonly deliveries: DeliveryService,
  ) {}

  async listar(
    distributorId: string,
    filtros: { status?: RouteBatchStatus; limit: number; offset: number },
  ): Promise<RouteBatchPageDto> {
    const [lotes, total] = await this.batches.findAndCount({
      where: {
        distributorId,
        ...(filtros.status ? { status: filtros.status } : {}),
      },
      order: { createdAt: 'DESC', batchId: 'ASC' },
      take: filtros.limit,
      skip: filtros.offset,
    });
    return {
      data: await this.armar(lotes),
      total,
      counts: await this.contarPorEstado(distributorId),
    };
  }

  async detalle(
    distributorId: string,
    batchId: string,
  ): Promise<RouteBatchResponseDto> {
    const lote = await this.batches.findOne({
      where: { batchId, distributorId },
    });
    if (!lote) throw new NotFoundException('Lote no encontrado');
    return (await this.armar([lote]))[0];
  }

  /** El lote armado para el panel, tal como lo devuelve `detalle`. */
  async porLote(batch: RouteBatch): Promise<RouteBatchResponseDto> {
    return (await this.armar([batch]))[0];
  }

  /**
   * Los lotes que el chofer puede ver: el que espera SU respuesta (oferta
   * pendiente de un lote ofrecido) y los que le fueron asignados, y de cada uno
   * sólo las paradas vivas. Los que rechazó, dejó vencer o se deshicieron no se
   * listan: llevan datos de clientes que ya no son suyos.
   */
  async delChofer(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: DriverRouteBatchResponseDto[]; total: number }> {
    const delivery = await this.chofer(userId);
    const visibles = await this.visiblesDelChofer(delivery);
    const orden = [...visibles].sort(
      (a, b) =>
        Number(b.oferta.status === ProposalStatus.PENDING) -
          Number(a.oferta.status === ProposalStatus.PENDING) ||
        b.oferta.expiresAt.getTime() - a.oferta.expiresAt.getTime(),
    );
    const pagina = orden.slice(offset, offset + limit);
    return { data: await this.paraElChofer(pagina), total: orden.length };
  }

  async unoDelChofer(
    userId: string,
    batchId: string,
  ): Promise<DriverRouteBatchResponseDto> {
    const delivery = await this.chofer(userId);
    const visible = (await this.visiblesDelChofer(delivery)).find(
      (v) => v.lote.batchId === batchId,
    );
    if (!visible) throw new NotFoundException('Lote no encontrado');
    return (await this.paraElChofer([visible]))[0];
  }

  private async visiblesDelChofer(
    delivery: Delivery,
  ): Promise<Array<{ oferta: RouteBatchOffer; lote: RouteBatch }>> {
    const propias = await this.offers.find({
      where: { deliveryId: delivery.deliveryId },
      order: { expiresAt: 'DESC' },
    });
    if (propias.length === 0) return [];
    const lotes = await this.batches.find({
      where: { batchId: In(propias.map((o) => o.batchId)) },
    });
    const porId = new Map(lotes.map((l) => [l.batchId, l]));
    const resultado: Array<{ oferta: RouteBatchOffer; lote: RouteBatch }> = [];
    const vistos = new Set<string>();
    for (const oferta of propias) {
      const lote = porId.get(oferta.batchId);
      if (!lote || vistos.has(lote.batchId)) continue;
      const esperaMiRespuesta =
        oferta.status === ProposalStatus.PENDING &&
        lote.status === RouteBatchStatus.OFFERED;
      const esMio =
        lote.deliveryId === delivery.deliveryId &&
        (lote.status === RouteBatchStatus.ASSIGNED ||
          lote.status === RouteBatchStatus.COMPLETED);
      if (!esperaMiRespuesta && !esMio) continue;
      vistos.add(lote.batchId);
      resultado.push({ oferta, lote });
    }
    return resultado;
  }

  private async chofer(userId: string): Promise<Delivery> {
    const delivery = await this.deliveries.buscarPorIdOUsuario(userId);
    if (!delivery || delivery.userId !== userId) {
      throw new NotFoundException('Lote no encontrado');
    }
    return delivery;
  }

  private async paraElChofer(
    visibles: Array<{ oferta: RouteBatchOffer; lote: RouteBatch }>,
  ): Promise<DriverRouteBatchResponseDto[]> {
    if (visibles.length === 0) return [];
    const paradas = await this.paradasDe(visibles.map((v) => v.lote.batchId));
    return visibles.map(({ oferta, lote }) =>
      RouteBatchMapper.loteDelChofer(
        lote,
        paradas.filter((p) => p.batchId === lote.batchId && p.active),
        oferta,
      ),
    );
  }

  private async armar(lotes: RouteBatch[]): Promise<RouteBatchResponseDto[]> {
    if (lotes.length === 0) return [];
    const ids = lotes.map((l) => l.batchId);
    const [paradas, ofertas] = await Promise.all([
      this.paradasDe(ids),
      this.offers.find({ where: { batchId: In(ids) } }),
    ]);
    const choferes = await this.choferesDe([
      ...ofertas.map((o) => o.deliveryId),
      ...lotes.flatMap((l) => (l.deliveryId ? [l.deliveryId] : [])),
    ]);
    return lotes.map((lote) =>
      RouteBatchMapper.lote(
        lote,
        paradas.filter((p) => p.batchId === lote.batchId),
        ofertas.filter((o) => o.batchId === lote.batchId),
        choferes,
      ),
    );
  }

  private paradasDe(batchIds: string[]): Promise<RouteBatchStop[]> {
    return this.stops.find({
      where: { batchId: In(batchIds) },
      relations: RELACIONES_DE_LA_PARADA,
      order: { sequence: 'ASC' },
      withDeleted: true,
    });
  }

  private async choferesDe(deliveryIds: string[]): Promise<ChoferesDelLote> {
    const unicos = [...new Set(deliveryIds)];
    const mapa: ChoferesDelLote = new Map();
    for (const id of unicos) {
      const d = await this.deliveries.buscarPorIdOUsuario(id, true);
      if (d) {
        mapa.set(id, {
          deliveryId: d.deliveryId,
          userId: d.userId,
          name: d.user?.fullName ?? null,
        });
      }
    }
    return mapa;
  }

  private async contarPorEstado(
    distributorId: string,
  ): Promise<Record<string, number>> {
    const filas: Array<{ status: string; n: string }> = await this.batches
      .createQueryBuilder('b')
      .select('b.status', 'status')
      .addSelect('COUNT(*)', 'n')
      .where('b.distributorId = :distributorId', { distributorId })
      .groupBy('b.status')
      .getRawMany();
    const conteo: Record<string, number> = Object.fromEntries(
      Object.values(RouteBatchStatus).map((s) => [s, 0]),
    );
    for (const f of filas) conteo[f.status] = Number(f.n);
    return conteo;
  }
}
