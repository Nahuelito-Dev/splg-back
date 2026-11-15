import type { Repository } from 'typeorm';
import { AdminNotification } from '../../../admin-notifications/entities/admin-notification.entity';
import { AuditLog } from '../../../audit/entities/audit-log.entity';
import { ProcessRun } from '../../../process-run/entities/process-run.entity';
import { TrazasService } from '../trazas.service';

interface Busqueda {
  where: Record<string, unknown>;
  take?: number;
}

/** Un repositorio de sólo `find` por igualdad, sobre un arreglo. */
export function repoEnMemoria<T extends object>(filas: T[]): Repository<T> {
  return {
    find: ({ where, take }: Busqueda) =>
      Promise.resolve(
        filas
          .filter((f) =>
            Object.entries(where).every(
              ([k, v]) => (f as Record<string, unknown>)[k] === v,
            ),
          )
          .slice(0, take),
      ),
  } as unknown as Repository<T>;
}

export interface FuentesDeTraza {
  asientos: AuditLog[];
  corridas: ProcessRun[];
  avisos: AdminNotification[];
}

export function trazasEnMemoria(fuentes: FuentesDeTraza): TrazasService {
  return new TrazasService(
    repoEnMemoria(fuentes.asientos),
    repoEnMemoria(fuentes.corridas),
    repoEnMemoria(fuentes.avisos),
  );
}
