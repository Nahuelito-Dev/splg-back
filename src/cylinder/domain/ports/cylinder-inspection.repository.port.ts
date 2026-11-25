import type { NuevaRevision } from '../envase';
import type { Transaccion } from './unit-of-work.port';

/** PUERTO del historial de revisiones periódicas del envase. */
export abstract class CylinderInspectionRepositoryPort {
  abstract registrar(tx: Transaccion, revision: NuevaRevision): Promise<void>;
}
