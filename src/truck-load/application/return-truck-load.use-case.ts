import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { withTransactionRetry } from '../../common/utils/with-transaction-retry';
import {
  CargaInvalidaError,
  TransicionDeCargaInvalidaError,
} from '../domain/errors/truck-load.errors';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { puedeHacer, validarDeclaracion } from '../domain/truck-load-rules';
import { ReturnTruckLoadDto } from '../dto/truck-load.dto';
import { TruckLoadItem } from '../entities/truck-load-item.entity';
import {
  ahoraDeLaBase,
  asegurarAlcance,
  bloquearCarga,
} from './truck-load-support';

/**
 * El chofer (o el administrador) declara lo que vuelve en el camión y la carga
 * pasa a `returned`, pendiente de la rendición. No mueve stock: el sistema
 * calcula lo esperado y la diferencia recién al cerrar. Se puede volver a
 * declarar mientras no se cerró.
 */
@Injectable()
export class ReturnTruckLoadUseCase {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly orders: OrderLookupService,
  ) {}

  async execute(
    id: string,
    dto: ReturnTruckLoadDto,
    distributorId: string,
    alcance: string | undefined,
  ): Promise<void> {
    await withTransactionRetry(
      () =>
        this.dataSource.transaction(async (manager) => {
          const carga = await bloquearCarga(manager, id, distributorId);
          asegurarAlcance(carga, alcance);
          if (!puedeHacer('declarar', carga.status)) {
            throw new TransicionDeCargaInvalidaError(
              carga.number,
              carga.status,
              'declarar la vuelta',
            );
          }
          // Con pedidos en curso el chofer todavía no volvió: lo que entregue
          // después de declarar aparecería como diferencia en la rendición.
          const enCurso = await this.orders.countEnCurso(
            carga.deliveryId,
            manager,
          );
          if (enCurso > 0) {
            throw new ConflictException(
              `Tenés ${enCurso} ${enCurso === 1 ? 'pedido' : 'pedidos'} en curso: entregalos o liberalos antes de volver`,
            );
          }
          const items = await manager.find(TruckLoadItem, {
            where: { loadId: id },
          });
          const idsDeLaCarga = items.map((i) => i.gasCylinderId);
          const ajenas = dto.items.filter(
            (d) => !idsDeLaCarga.includes(d.gasCylinderId),
          );
          if (ajenas.length > 0) {
            throw new CargaInvalidaError(
              `La garrafa ${ajenas[0].gasCylinderId} no es de esta carga`,
            );
          }
          validarDeclaracion(dto.items, idsDeLaCarga);
          const declarado = new Map(dto.items.map((d) => [d.gasCylinderId, d]));
          for (const item of items) {
            const d = declarado.get(item.gasCylinderId)!;
            item.declaredReturnFull = d.declaredFull;
            item.declaredReturnEmpty = d.declaredEmpty;
          }
          await manager.save(items);
          carga.status = TruckLoadStatus.RETURNED;
          carga.returnedAt = await ahoraDeLaBase(manager);
          await manager.save(carga);
        }),
      { context: 'vuelta del camión' },
    );
  }
}
