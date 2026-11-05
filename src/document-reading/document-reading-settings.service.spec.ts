import { ConfigurableProcess } from '../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../distributor/process-config.service';
import { DocumentReadingSettingsService } from './document-reading-settings.service';

describe('DocumentReadingSettingsService', () => {
  it.each([
    [0, false],
    [1, true],
  ])('traduce enabled=%i a %s', async (enabled, esperado) => {
    const obtener = jest.fn().mockResolvedValue({
      enabled,
      frequencyMinutes: 12,
      batchSize: 7,
      maxAttempts: 4,
      monthlyBudgetUsd: 3.5,
      typesMask: 5,
    });
    const service = new DocumentReadingSettingsService({
      obtener,
    } as unknown as ProcessConfigService);
    await expect(service.parametros('d1')).resolves.toEqual({
      enabled: esperado,
      frequencyMinutes: 12,
      batchSize: 7,
      maxAttempts: 4,
      monthlyBudgetUsd: 3.5,
      typesMask: 5,
    });
    expect(obtener).toHaveBeenCalledWith(
      'd1',
      ConfigurableProcess.DOCUMENT_READING,
    );
  });
});
