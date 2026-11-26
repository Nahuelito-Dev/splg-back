import { Injectable } from '@nestjs/common';
import { NuevaRevision } from '../domain/envase';
import { CylinderInspectionRepositoryPort } from '../domain/ports/cylinder-inspection.repository.port';
import { Transaccion } from '../domain/ports/unit-of-work.port';
import { CylinderInspection } from '../entities/cylinder-inspection.entity';
import { managerDe } from './typeorm-unit-of-work.adapter';

/** Adaptador TypeORM del historial de revisiones (`cylinder_inspection`). */
@Injectable()
export class CylinderInspectionTypeormRepository extends CylinderInspectionRepositoryPort {
  async registrar(tx: Transaccion, revision: NuevaRevision): Promise<void> {
    const inspections = managerDe(tx).getRepository(CylinderInspection);
    await inspections.save(
      inspections.create({
        cylinderId: revision.cylinderId,
        distributorId: revision.distributorId,
        inspectedAt: revision.inspectedAt,
        result: revision.result,
        nextDueAt: revision.nextDueAt,
        notes: revision.notes,
      }),
    );
  }
}
