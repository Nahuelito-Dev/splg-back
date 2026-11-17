import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  calcularMetricasDeDespacho,
  OfertaMedida,
  PedidoMedido,
} from '../domain/dispatch-metrics';
import { MOTIVO_VENCIMIENTO_SIN_CHOFER } from '../domain/vencimiento-sin-chofer';
import { DispatchMetricsResponseDto } from '../dto/dispatch-metrics-response.dto';

export const DIAS_POR_OMISION = 30;
export const DIAS_MAXIMOS = 366;
const DIA_MS = 24 * 3600 * 1000;

/** Métricas del despacho automático (M1) de una distribuidora en un período. */
@Injectable()
export class DispatchMetricsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Resuelve el período: por omisión, los últimos 30 días hasta ahora. */
  periodo(
    from: string | undefined,
    to: string | undefined,
    ahora: Date = new Date(),
  ): { desde: Date; hasta: Date } {
    const leer = (v: string | undefined, campo: string): Date | null => {
      if (v === undefined || v === '') return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException(
          `El campo "${campo}" tiene que ser una fecha válida (por ejemplo 2026-11-01).`,
        );
      }
      return d;
    };
    const hasta = leer(to, 'to') ?? ahora;
    const desde =
      leer(from, 'from') ??
      new Date(hasta.getTime() - DIAS_POR_OMISION * DIA_MS);
    if (desde.getTime() > hasta.getTime()) {
      throw new BadRequestException(
        'La fecha "from" no puede ser posterior a "to".',
      );
    }
    if (hasta.getTime() - desde.getTime() > DIAS_MAXIMOS * DIA_MS) {
      throw new BadRequestException(
        `El período no puede pasar de ${DIAS_MAXIMOS} días.`,
      );
    }
    return { desde, hasta };
  }

  async obtener(
    distributorId: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<DispatchMetricsResponseDto> {
    const { desde, hasta } = this.periodo(from, to);

    const ofertasFilas: Array<{
      orderId: string;
      driverId: string;
      driverName: string | null;
      status: OfertaMedida['status'];
      offeredAt: Date;
      respondedAt: Date | null;
    }> = await this.dataSource.query(
      `SELECT f."order_id" AS "orderId", f."driver_id" AS "driverId",
              u."full_name" AS "driverName", f."status", f."offeredAt", f."respondedAt"
         FROM "order_dispatch_offer" f
         JOIN "user" u ON u."user_id" = f."driver_id"
        WHERE f."distributor_id" = $1 AND f."offeredAt" >= $2 AND f."offeredAt" <= $3`,
      [distributorId, desde, hasta],
    );

    const pedidosFilas: Array<{ esperaDesde: Date; aceptadoEn: Date | null }> =
      await this.dataSource.query(
        `SELECT COALESCE(o."available_since", o."createdAt") AS "esperaDesde",
                o."acceptedAt" AS "aceptadoEn"
           FROM "order" o
          WHERE o."distributor_id" = $1
            AND EXISTS (SELECT 1 FROM "order_dispatch_offer" f
                         WHERE f."order_id" = o."order_id" AND f."distributor_id" = $1
                           AND f."offeredAt" >= $2 AND f."offeredAt" <= $3)`,
        [distributorId, desde, hasta],
      );

    const sinChofer: Array<{ total: string }> = await this.dataSource.query(
      `SELECT count(*) AS "total" FROM "order" o
        WHERE o."distributor_id" = $1 AND o."status" = 'cancelled'
          AND o."cancellationReason" = $2
          AND o."updatedAt" >= $3 AND o."updatedAt" <= $4`,
      [distributorId, MOTIVO_VENCIMIENTO_SIN_CHOFER, desde, hasta],
    );

    const metricas = calcularMetricasDeDespacho({
      ofertas: ofertasFilas.map((f) => ({
        ...f,
        driverName: f.driverName ?? 'Chofer',
        offeredAt: new Date(f.offeredAt),
        respondedAt: f.respondedAt ? new Date(f.respondedAt) : null,
      })),
      pedidos: pedidosFilas.map(
        (p): PedidoMedido => ({
          esperaDesde: new Date(p.esperaDesde),
          aceptadoEn: p.aceptadoEn ? new Date(p.aceptadoEn) : null,
        }),
      ),
      sinChofer: Number(sinChofer[0]?.total ?? 0),
    });
    return { from: desde.toISOString(), to: hasta.toISOString(), ...metricas };
  }
}
