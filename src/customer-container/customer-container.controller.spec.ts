import { CustomerContainerController } from './customer-container.controller';
import { CustomerContainerMovementReason } from './entities/customer-container-movement.entity';

describe('CustomerContainerController', () => {
  const listar = jest.fn();
  const listarMovimientos = jest.fn();
  const ajuste = jest.fn();
  const assertDeLaDistribuidora = jest.fn();
  const findOne = jest.fn();
  const transaction = jest.fn();
  const manager = {};
  const controller = new CustomerContainerController(
    { listar, listarMovimientos, ajuste } as never,
    { assertDeLaDistribuidora, findOne } as never,
    { manager, transaction } as never,
  );
  const distributorId = '11111111-1111-1111-1111-111111111111';
  const customerId = '22222222-2222-2222-2222-222222222222';
  const userId = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    jest.clearAllMocks();
    assertDeLaDistribuidora.mockResolvedValue(undefined);
    findOne.mockResolvedValue({ userId });
  });

  it('lista sólo después de verificar que el cliente pertenece a la distribuidora', async () => {
    listar.mockResolvedValue([{ gasCylinderId: 'tipo' }]);

    await expect(controller.listar(customerId, distributorId)).resolves.toEqual(
      {
        items: [{ gasCylinderId: 'tipo' }],
      },
    );
    expect(assertDeLaDistribuidora).toHaveBeenCalledWith(
      { customer_id: customerId },
      distributorId,
    );
    expect(listar).toHaveBeenCalledWith(manager, distributorId, userId);
  });

  it('respeta limit y offset al listar movimientos', async () => {
    listarMovimientos.mockResolvedValue({
      items: [],
      total: 0,
      limit: 20,
      offset: 4,
    });

    await controller.movimientos(
      customerId,
      { limit: 20, offset: 4 },
      distributorId,
    );

    expect(listarMovimientos).toHaveBeenCalledWith(
      manager,
      distributorId,
      userId,
      20,
      4,
    );
  });

  it('registra el ajuste dentro de una transacción con el actor autenticado', async () => {
    transaction.mockImplementation((fn: (m: object) => unknown) => fn(manager));
    ajuste.mockResolvedValue({ gasCylinderId: 'tipo', owned: 2 });
    const dto = {
      gasCylinderId: '44444444-4444-4444-4444-444444444444',
      quantity: 2,
      note: 'Ajuste manual válido',
    };

    await controller.ajustar(customerId, dto, distributorId, {
      user_id: '55555555-5555-5555-5555-555555555555',
    } as never);

    expect(ajuste).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        gasCylinderId: dto.gasCylinderId,
        quantity: dto.quantity,
        note: dto.note,
        customerUserId: userId,
        distributorId,
        actorUserId: '55555555-5555-5555-5555-555555555555',
        reason: CustomerContainerMovementReason.MANUAL_ADJUSTMENT,
      }),
    );
  });
});
