import { DocumentReadingController } from './document-reading.controller';
import { DocumentReadingRunnerService } from './document-reading-runner.service';
import { DocumentReadingService } from './document-reading.service';

describe('DocumentReadingController', () => {
  it('POST /v2/document-readings/run delega el dryRun al runner', async () => {
    const run = jest.fn().mockResolvedValue({
      distributors: 1,
      read: 2,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      budgetReached: 0,
    });
    const controller = new DocumentReadingController(
      {} as DocumentReadingService,
      { run } as unknown as DocumentReadingRunnerService,
    );
    await expect(controller.correr({ dryRun: true }, 'd1')).resolves.toEqual({
      distributors: 1,
      read: 2,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      budgetReached: 0,
    });
    expect(run).toHaveBeenCalledWith('d1', { dryRun: true });
  });
});
