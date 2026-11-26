import { EnvaseDevueltoEvent } from '../domain/events/envase-devuelto.event';
import { CylinderRecoveryListener } from './cylinder-recovery.listener';
import { CylinderRecoveryService } from './cylinder-recovery.service';

describe('CylinderRecoveryListener', () => {
  const evento = new EnvaseDevueltoEvent('dist-1', 'cyl-1', 'cust-1', null);
  let recovery: { cerrarPorDevolucion: jest.Mock };
  let listener: CylinderRecoveryListener;

  beforeEach(() => {
    recovery = { cerrarPorDevolucion: jest.fn().mockResolvedValue(true) };
    listener = new CylinderRecoveryListener(
      recovery as unknown as CylinderRecoveryService,
    );
  });

  it('al devolverse el envase cierra su caso', async () => {
    await listener.alDevolverse(evento);
    expect(recovery.cerrarPorDevolucion).toHaveBeenCalledWith(
      'dist-1',
      'cyl-1',
    );
  });

  it('si cerrar falla no se propaga: la próxima corrida lo cierra', async () => {
    recovery.cerrarPorDevolucion.mockRejectedValue(new Error('boom'));
    await expect(listener.alDevolverse(evento)).resolves.toBeUndefined();
  });
});
