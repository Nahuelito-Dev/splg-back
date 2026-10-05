import { JobPositionSeedListener } from './job-position-seed.listener';
import { JobPositionService } from './job-position.service';
import { DistribuidoraCreadaEvent } from '../distributor/events/distribuidora-creada.event';

describe('JobPositionSeedListener', () => {
  it('siembra los puestos base de la distribuidora recién creada', async () => {
    const positions = { sembrarBase: jest.fn().mockResolvedValue(5) };
    const listener = new JobPositionSeedListener(
      positions as unknown as JobPositionService,
    );

    await listener.handle(new DistribuidoraCreadaEvent('d1'));

    expect(positions.sembrarBase).toHaveBeenCalledWith('d1');
  });
});
