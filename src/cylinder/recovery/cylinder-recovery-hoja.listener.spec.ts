import { CylinderRecoveryHojaListener } from './cylinder-recovery-hoja.listener';
import { CylinderRecoveryPickupOpportunityService } from './cylinder-recovery-pickup-opportunity.service';

describe('CylinderRecoveryHojaListener', () => {
  const ofrecer = jest.fn();
  const listener = new CylinderRecoveryHojaListener({
    ofrecer,
  } as unknown as CylinderRecoveryPickupOpportunityService);

  beforeEach(() => ofrecer.mockReset());

  it('al haber una hoja en curso ofrece los retiros de esa distribuidora y esa hoja', async () => {
    ofrecer.mockResolvedValue(2);
    await listener.alHaberHojaEnCurso({ distributorId: 'd1', batchId: 'h1' });
    expect(ofrecer).toHaveBeenCalledWith('d1', 'h1');
  });

  it('en la pasada del seguimiento (sin distribuidora ni hoja) recorre todas', async () => {
    ofrecer.mockResolvedValue(0);
    await listener.alHaberHojaEnCurso({ distributorId: null, batchId: null });
    expect(ofrecer).toHaveBeenCalledWith(null, null);
  });

  it('si falla no propaga el error: la pasada siguiente lo reintenta', async () => {
    ofrecer.mockRejectedValue(new Error('base caída'));
    await expect(
      listener.alHaberHojaEnCurso({ distributorId: 'd1', batchId: 'h1' }),
    ).resolves.toBeUndefined();
  });
});
