import { Repository } from 'typeorm';
import { CustomerContainerService } from '../../customer-container/customer-container.service';
import { CustomerContainerMovementReason } from '../../customer-container/entities/customer-container-movement.entity';
import { ContainerChargeSettingsService } from '../../distributor/container-charge-settings.service';
import { CylinderRecoveryCase } from '../entities/cylinder-recovery-case.entity';
import { CylinderRecoveryAccountService } from './cylinder-recovery-account.service';
import { DIST } from './recovery-test-kit';

describe('CylinderRecoveryAccountService (F35 E5)', () => {
  let query: jest.Mock;
  let tx: { query: jest.Mock };
  let cobro: { habilitado: jest.Mock };
  let cuentas: { registrar: jest.Mock };
  let service: CylinderRecoveryAccountService;

  beforeEach(() => {
    query = jest.fn();
    tx = { query: jest.fn() };
    cobro = { habilitado: jest.fn().mockResolvedValue(true) };
    cuentas = { registrar: jest.fn().mockResolvedValue(1) };
    service = new CylinderRecoveryAccountService(
      {
        manager: {
          query,
          transaction: jest.fn((fn: (m: unknown) => unknown) => fn(tx)),
        },
      } as unknown as Repository<CylinderRecoveryCase>,
      cobro as unknown as ContainerChargeSettingsService,
      cuentas as unknown as CustomerContainerService,
    );
  });

  describe('cubiertos', () => {
    it('con «Cobrar envases» apagado no excluye nada ni consulta la cuenta', async () => {
      cobro.habilitado.mockResolvedValue(false);
      await expect(service.cubiertos(DIST)).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it('encendido: los más nuevos que cubren los propios, filtrado por la distribuidora', async () => {
      query.mockResolvedValue([
        { cylinderId: 'c-3', customerId: 'cust-1' },
        { cylinderId: 'c-9', customerId: 'cust-2' },
      ]);
      const r = await service.cubiertos(DIST);
      expect(r).toEqual(
        new Map([
          ['c-3', 'cust-1'],
          ['c-9', 'cust-2'],
        ]),
      );
      const [sql, params] = query.mock.calls[0] as [string, string[]];
      expect(params).toEqual([DIST, null, null]);
      expect(sql).toContain('c.distributor_id = $1');
      expect(sql).toContain('cu.distributor_id = $1');
      expect(sql).toContain('k.distributor_id = c.distributor_id');
      expect(sql).toContain("k.status = 'deposit_charged'");
      expect(sql).toContain('ORDER BY a.delivered_at DESC NULLS LAST');
      expect(sql).toContain('GREATEST(0, owned - cobrados)');
    });
  });

  describe('compraPorDeposito', () => {
    const datos = {
      distributorId: DIST,
      customerUserId: 'cust-1',
      gasCylinderId: 'tipo-10' as string | null,
      serial: 'SN-1',
      actorUserId: 'admin-1',
    };

    it('encendido: suma uno a la cuenta como compra, en la transacción de la decisión', async () => {
      const manager = { soy: 'la transacción' };
      await expect(
        service.compraPorDeposito(manager as never, datos),
      ).resolves.toBe(true);
      expect(cuentas.registrar).toHaveBeenCalledWith(manager, {
        distributorId: DIST,
        customerUserId: 'cust-1',
        gasCylinderId: 'tipo-10',
        quantity: 1,
        reason: CustomerContainerMovementReason.PURCHASED,
        note: 'Depósito cobrado en el recupero del envase SN-1',
        actorUserId: 'admin-1',
      });
    });

    it('apagado no toca la cuenta', async () => {
      cobro.habilitado.mockResolvedValue(false);
      await expect(service.compraPorDeposito({} as never, datos)).resolves.toBe(
        false,
      );
      expect(cuentas.registrar).not.toHaveBeenCalled();
    });

    it('un envase sin tipo no tiene cuenta que sumar', async () => {
      await expect(
        service.compraPorDeposito({} as never, {
          ...datos,
          gasCylinderId: null,
        }),
      ).resolves.toBe(false);
      expect(cuentas.registrar).not.toHaveBeenCalled();
    });

    it('si la cuenta falla, el error sube para que la decisión revierta', async () => {
      cuentas.registrar.mockRejectedValue(new Error('cuenta caída'));
      await expect(
        service.compraPorDeposito({} as never, datos),
      ).rejects.toThrow('cuenta caída');
    });
  });

  describe('sigueCubierto (relectura bajo lock antes de cerrar)', () => {
    const datos = {
      distributorId: DIST,
      cylinderId: 'cyl-1',
      customerUserId: 'cust-1',
      gasCylinderId: 'tipo-10',
    };

    it('bloquea la cuenta del cliente y el tipo y recalcula sólo para ellos', async () => {
      tx.query
        .mockResolvedValueOnce([{ owned: 1 }])
        .mockResolvedValueOnce([{ cylinderId: 'cyl-1', customerId: 'cust-1' }]);
      await expect(service.sigueCubierto(tx as never, datos)).resolves.toBe(
        true,
      );
      const [[lock, pLock], [sql, pSql]] = tx.query.mock.calls as Array<
        [string, unknown[]]
      >;
      expect(lock).toContain('FOR UPDATE');
      expect(pLock).toEqual([DIST, 'cust-1', 'tipo-10']);
      expect(sql).toContain('WITH afuera AS');
      expect(pSql).toEqual([DIST, 'cust-1', 'tipo-10']);
      expect(query).not.toHaveBeenCalled();
    });

    it('si el recálculo ya no lo cubre (p. ej. volvió otro envase), no sigue cubierto', async () => {
      tx.query
        .mockResolvedValueOnce([{ owned: 1 }])
        .mockResolvedValueOnce([{ cylinderId: 'otro', customerId: 'cust-1' }]);
      await expect(service.sigueCubierto(tx as never, datos)).resolves.toBe(
        false,
      );
    });

    it('con el cobro apagado no cubre nada', async () => {
      cobro.habilitado.mockResolvedValue(false);
      await expect(service.sigueCubierto(tx as never, datos)).resolves.toBe(
        false,
      );
      expect(tx.query).not.toHaveBeenCalled();
    });
  });
});
