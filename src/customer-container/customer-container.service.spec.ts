import { ConflictException, NotFoundException } from '@nestjs/common';
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
  const service = new CustomerContainerService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('crea la cuenta, suma el saldo y asienta el movimiento', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[{ account_id: 'cuenta', owned: 2 }], 1]);

    await expect(service.registrar(manager, DATOS)).resolves.toBe(2);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT'),
      expect.any(Array),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('owned + $1 >= 0'),
      expect.any(Array),
    );
    expect(insertar).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'cuenta',
        quantity: 2,
        reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
      }),
    );
  });

  it('registra ajustes negativos sólo si el update conserva saldo no negativo', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[{ account_id: 'cuenta', owned: 1 }], 1]);

    await expect(
      service.registrar(manager, { ...DATOS, quantity: -1 }),
    ).resolves.toBe(1);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.arrayContaining([-1]),
    );
  });

  it('rechaza el ajuste que dejaría saldo negativo sin insertar movimiento', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([[], 0]);

    await expect(
      service.registrar(manager, { ...DATOS, quantity: -3 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(insertar).not.toHaveBeenCalled();
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
});
