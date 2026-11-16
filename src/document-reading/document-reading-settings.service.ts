import { Injectable } from '@nestjs/common';
import { ConfigurableProcess } from '../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../distributor/process-config.service';

export interface DocumentReadingSettings {
  enabled: boolean;
  frequencyMinutes: number;
  batchSize: number;
  maxAttempts: number;
  monthlyBudgetUsd: number;
  typesMask: number;
  amountTolerancePct: number;
  dateToleranceDays: number;
  proposalTtlHours: number;
  reminderTtlHours: number;
}

@Injectable()
export class DocumentReadingSettingsService {
  constructor(private readonly config: ProcessConfigService) {}
  async parametros(distributorId: string): Promise<DocumentReadingSettings> {
    const p = await this.config.obtener(
      distributorId,
      ConfigurableProcess.DOCUMENT_READING,
    );
    return {
      enabled: p.enabled === 1,
      frequencyMinutes: p.frequencyMinutes,
      batchSize: p.batchSize,
      maxAttempts: p.maxAttempts,
      monthlyBudgetUsd: p.monthlyBudgetUsd,
      typesMask: p.typesMask,
      amountTolerancePct: p.amountTolerancePct,
      dateToleranceDays: p.dateToleranceDays,
      proposalTtlHours: p.proposalTtlHours,
      reminderTtlHours: p.reminderTtlHours,
    };
  }
}
