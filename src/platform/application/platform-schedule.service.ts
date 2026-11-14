import { Injectable } from '@nestjs/common';
import { DistributorService } from '../../distributor/distributor.service';
import {
  ScheduledTasksSettingsService,
  ScheduledTasksVigentes,
} from '../../distributor/scheduled-tasks-settings.service';
import type { TareaConIntervalo } from '../../distributor/scheduled-tasks-settings';

/**
 * La frecuencia de las tareas programadas de una empresa, desde la plataforma
 * (las cuatro frecuencias de máquina, por merge; la hora del aviso de flota es
 * de la empresa). 404 si la empresa no existe o está dada de baja.
 */
@Injectable()
export class PlatformScheduleService {
  constructor(
    private readonly distributors: DistributorService,
    private readonly tasks: ScheduledTasksSettingsService,
  ) {}

  async vigentes(distributorId: string): Promise<ScheduledTasksVigentes> {
    await this.distributors.findOne(distributorId);
    return this.tasks.vigentes(distributorId);
  }

  async guardar(
    distributorId: string,
    settings: Partial<Record<TareaConIntervalo, number>>,
    actorUserId: string,
  ): Promise<ScheduledTasksVigentes> {
    await this.distributors.findOne(distributorId);
    return this.tasks.guardarDeLaPlataforma(
      distributorId,
      settings,
      actorUserId,
    );
  }
}
