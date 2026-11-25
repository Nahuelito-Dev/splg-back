import { Injectable, NotFoundException } from '@nestjs/common';
import { ClockPort } from '../domain/ports/clock.port';
import { CylinderInspectionRepositoryPort } from '../domain/ports/cylinder-inspection.repository.port';
import { CylinderMovementRepositoryPort } from '../domain/ports/cylinder-movement.repository.port';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { UnitOfWorkPort } from '../domain/ports/unit-of-work.port';
import {
  DatosDeRevision,
  planificarRevision,
} from '../domain/revision-de-envase';
import { conErroresHttp } from './domain-error.translator';

/**
 * CU-132. Asienta la revisión periódica en el historial y, si es la más
 * reciente, copia en la ficha la última fecha y el vencimiento. Una revisión
 * anterior a la última cargada sólo entra al historial.
 */
@Injectable()
export class RegisterInspectionUseCase {
  constructor(
    private readonly envases: CylinderRepositoryPort,
    private readonly revisiones: CylinderInspectionRepositoryPort,
    private readonly movimientos: CylinderMovementRepositoryPort,
    private readonly uow: UnitOfWorkPort,
    private readonly reloj: ClockPort,
  ) {}

  execute(
    cylinderId: string,
    datos: DatosDeRevision,
    distributorId: string,
    actorUserId?: string,
  ): Promise<void> {
    return conErroresHttp(async () => {
      const plan = planificarRevision(datos, this.reloj.ahora());
      await this.uow.enTransaccion(async (tx) => {
        const envase = await this.envases.bloquear(
          tx,
          cylinderId,
          distributorId,
        );
        if (!envase) throw new NotFoundException('Envase no encontrado');

        const registrada = envase.registrarRevision(plan, actorUserId);
        await this.revisiones.registrar(tx, registrada.revision);
        if (!registrada.actualizaFicha) return;

        await this.envases.guardar(tx, envase);
        if (registrada.movimiento) {
          await this.movimientos.registrar(registrada.movimiento, tx);
        }
      });
    });
  }
}
