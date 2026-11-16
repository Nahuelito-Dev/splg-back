import { ConflictException, NotFoundException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { CustomerContainerService } from './customer-container.service';
import { CustomerContainerMovementReason } from './entities/customer-container-movement.entity';

const DATOS = {
  distributorId: '11111111-1111-1111-1111-111111111111',
  customerUserId: '22222222-2222-2222-2222-222222222222',
  gasCylinderId: '33333333-3333-3333-3333-333333333333',
  quantity: 2,
  reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
  note: 'Ajuste inicial documentado.',
  actorUserId: '44444444-4444-4444-4444-444444444444',
};

describe('CustomerContainerService', () => {
  const insertar = jest.fn();
  const query = jest.fn();
  const manager = {
    query,
    getRepository: jest.fn(() => ({ insert: insertar })),
  } as unknown as EntityManager;
  const containerChargeSettings = { habilitado: jest.fn() };
  const service = new CustomerContainerService(
    containerChargeSettings as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockReset();
    insertar.mockReset();
    containerChargeSettings.habilitado.mockResolvedValue(true);
  });

  it('crea la cuenta, suma el saldo y asienta el movimiento', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ account_id: 'cuenta', owned: 0 }])
      .mockResolvedValueOnce([{ account_id: 'cuenta' }])
      .mockResolvedValueOnce([[{ account_id: 'cuenta', owned: 2 }], 1]);

    await expect(service.registrar(manager, DATOS)).resolves.toBe(2);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT'),
      expect.any(Array),
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('owned + $1 >= 0'),
      expect.any(Array),
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO customer_container_movement'),
      expect.arrayContaining(['cuenta', 2]),
    );
  });

  it('registra ajustes negativos sólo si el update conserva saldo no negativo', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ account_id: 'cuenta', owned: 2 }])
      .mockResolvedValueOnce([{ account_id: 'cuenta' }])
      .mockResolvedValueOnce([[{ account_id: 'cuenta', owned: 1 }], 1]);

    await expect(
      service.registrar(manager, { ...DATOS, quantity: -1 }),
    ).resolves.toBe(1);
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.any(String),
      expect.arrayContaining([-1]),
    );
  });

  it('rechaza el ajuste que dejaría saldo negativo sin insertar movimiento', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ account_id: 'cuenta', owned: 0 }])
      .mockResolvedValueOnce([{ account_id: 'cuenta' }])
      .mockResolvedValueOnce([[], 0]);

    await expect(
      service.registrar(manager, { ...DATOS, quantity: -3 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO customer_container_movement'),
      expect.any(Array),
    );
  });

  it('calcula el saldo inicial sólo desde pedidos entregados e inserta el movimiento una vez', async () => {
    query.mockResolvedValueOnce([]);

    await service.inicializarSaldoDesdeEntregas(manager);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('MAX(oi.quantity)'),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("o.status = 'delivered'"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE reason = 'initial_from_deliveries'"),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET owned = a.owned + i.quantity'),
    );
  });

  it('lista tipos activos aunque el cliente todavía tenga cero envases', async () => {
    query.mockResolvedValueOnce([]);

    await service.listar(manager, DATOS.distributorId, DATOS.customerUserId);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('g."isActive" = true'),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AS "isActive"'),
      expect.any(Array),
    );
  });

  it('incluye tipos inactivos si hay saldo propio o envases prestados por M5', async () => {
    query.mockResolvedValueOnce([]);

    await service.listar(manager, DATOS.distributorId, DATOS.customerUserId);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('COALESCE(a.owned, 0) > 0'),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("c.state = 'with_customer'"),
      expect.any(Array),
    );
  });

  it('loanedByM5 informa sólo los reclamables con «Cobrar envases» encendido (F35 E5)', async () => {
    query.mockResolvedValue([]);

    await service.listar(manager, DATOS.distributorId, DATOS.customerUserId);
    containerChargeSettings.habilitado.mockResolvedValueOnce(false);
    await service.listar(manager, DATOS.distributorId, DATOS.customerUserId);

    expect(containerChargeSettings.habilitado).toHaveBeenCalledWith(
      DATOS.distributorId,
    );
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('GREATEST(0, COUNT(c.cylinder_id)'),
      [DATOS.distributorId, DATOS.customerUserId, true],
    );
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), [
      DATOS.distributorId,
      DATOS.customerUserId,
      false,
    ]);
  });

  it('acepta cualquier tipo de la distribuidora, incluso uno inactivo', async () => {
    query.mockResolvedValueOnce([{ existe: true }]);

    await expect(
      service.asegurarTipoDeLaDistribuidora(
        manager,
        DATOS.distributorId,
        DATOS.gasCylinderId,
      ),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('is_active'),
      expect.any(Array),
    );
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining('"isActive" = true'),
      expect.any(Array),
    );
  });

  it('rechaza un tipo de otra distribuidora', async () => {
    query.mockResolvedValueOnce([{ existe: false }]);

    await expect(
      service.asegurarTipoDeLaDistribuidora(
        manager,
        DATOS.distributorId,
        DATOS.gasCylinderId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('envasesACobrar', () => {
    const item = {
      gasCylinderId: DATOS.gasCylinderId,
      quantity: 3,
      containerPrice: 10000,
      type: '10 kg',
    };

    it.each([
      ['sin cuenta cobra todos', { owned: 0, committed: 0 }, 3],
      ['cuenta suficiente no cobra', { owned: 3, committed: 0 }, 0],
      ['cuenta parcial cobra la diferencia', { owned: 2, committed: 0 }, 1],
      [
        'pedidos abiertos comprometen los envases',
        { owned: 3, committed: 2 },
        2,
      ],
    ])('%s', async (_caso, fila, expected) => {
      query.mockResolvedValueOnce([
        { ...fila, gas_cylinder_id: DATOS.gasCylinderId },
      ]);

      const [cargo] = await service.envasesACobrar(
        manager,
        DATOS.distributorId,
        DATOS.customerUserId,
        [item],
      );

      expect(cargo.containersCharged).toBe(expected);
      expect(cargo.containerSubtotal.toNumber()).toBe(expected * 10000);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining(
          "o.status IN ('reserved', 'pending', 'accepted', 'on_the_way')",
        ),
        expect.any(Array),
      );
    });

    it('rechaza si falta el precio del envase que hay que cobrar', async () => {
      query.mockResolvedValueOnce([
        { owned: 0, committed: 0, gas_cylinder_id: DATOS.gasCylinderId },
      ]);

      await expect(
        service.envasesACobrar(
          manager,
          DATOS.distributorId,
          DATOS.customerUserId,
          [{ ...item, containerPrice: null }],
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('apagado devuelve cargos en cero sin consultar cuenta ni precio', async () => {
      containerChargeSettings.habilitado.mockResolvedValue(false);

      await expect(
        service.envasesACobrar(
          manager,
          DATOS.distributorId,
          DATOS.customerUserId,
          [{ ...item, containerPrice: null }],
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          containersCharged: 0,
          containerUnitPrice: null,
        }),
      ]);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('descontarPropioDevuelto (F35 E5, en la transacción de la devolución)', () => {
    const datos = (orderId: string | null = null) => ({
      distributorId: DATOS.distributorId,
      customerUserId: DATOS.customerUserId,
      cylinderId: 'cyl-1',
      orderId,
    });
    /** Envase, [canje], cuenta bloqueada, envases en su poder y, si descuenta, el `registrar`. */
    const base = (owned: number, n: number, canje?: boolean) => {
      query.mockResolvedValueOnce([
        { gas_cylinder_id: DATOS.gasCylinderId, serial: 'SN-1' },
      ]);
      if (canje !== undefined) query.mockResolvedValueOnce(canje ? [{}] : []);
      query
        .mockResolvedValueOnce([{ account_id: 'cuenta', owned }])
        .mockResolvedValueOnce([{ n }]);
    };

    it('con más propios que envases en su poder descuenta uno como devolución', async () => {
      base(2, 1);
      const registrar = jest.spyOn(service, 'registrar').mockResolvedValue(1);
      await expect(
        service.descontarPropioDevuelto(manager, datos()),
      ).resolves.toBe(true);
      expect(registrar).toHaveBeenCalledWith(manager, {
        distributorId: DATOS.distributorId,
        customerUserId: DATOS.customerUserId,
        gasCylinderId: DATOS.gasCylinderId,
        quantity: -1,
        reason: CustomerContainerMovementReason.RETURNED,
        note: 'Devolvió el envase propio SN-1',
      });
      expect((query.mock.calls[1] as [string])[0]).toContain('FOR UPDATE');
      for (const [, params] of query.mock.calls as Array<[string, string[]]>) {
        expect(params).toContain(DATOS.distributorId);
      }
      registrar.mockRestore();
    });

    it('con los propios iguales a los que tiene no descuenta (era prestado)', async () => {
      base(1, 1);
      await expect(
        service.descontarPropioDevuelto(manager, datos()),
      ).resolves.toBe(false);
      expect(query).toHaveBeenCalledTimes(3);
    });

    it('el canje en un pedido del mismo cliente no toca la cuenta', async () => {
      base(2, 0, true);
      await expect(
        service.descontarPropioDevuelto(manager, datos('ord-1')),
      ).resolves.toBe(false);
      expect(query.mock.calls[1]).toEqual([
        expect.stringContaining('FROM "order"'),
        ['ord-1', DATOS.distributorId, DATOS.customerUserId],
      ]);
    });

    it('sin cuenta, sin tipo o con el cobro apagado no hace nada', async () => {
      query
        .mockResolvedValueOnce([
          { gas_cylinder_id: DATOS.gasCylinderId, serial: 'S' },
        ])
        .mockResolvedValueOnce([]);
      await expect(
        service.descontarPropioDevuelto(manager, datos()),
      ).resolves.toBe(false);
      query.mockResolvedValueOnce([{ gas_cylinder_id: null, serial: 'S' }]);
      await expect(
        service.descontarPropioDevuelto(manager, datos()),
      ).resolves.toBe(false);
      containerChargeSettings.habilitado.mockResolvedValueOnce(false);
      query.mockClear();
      await expect(
        service.descontarPropioDevuelto(manager, datos()),
      ).resolves.toBe(false);
      expect(query).not.toHaveBeenCalled();
    });

    it('si el descuento falla, el error sube (la devolución revierte)', async () => {
      base(2, 1);
      query.mockRejectedValueOnce(new Error('base caída'));
      await expect(
        service.descontarPropioDevuelto(manager, datos()),
      ).rejects.toThrow('base caída');
    });
  });
});
