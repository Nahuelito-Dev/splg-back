import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import {
  CashDirection,
  CashMethod,
  CashReferenceType,
} from '../domain/cash.enums';
import { CashMapper } from '../cash.mapper';
import type { CashMovement } from '../entities/cash-movement.entity';
import { CashMovementController } from './cash-movement.controller';
import { CashMovementV2Controller } from './cash-movement-v2.controller';

const movimiento = (over: Partial<CashMovement> = {}): CashMovement =>
  ({
    movementId: 'm-1',
    cashBoxId: 'c-1',
    sessionId: null,
    direction: CashDirection.IN,
    amount: 100,
    categoryId: 'k-1',
    method: CashMethod.MERCADOPAGO,
    occurredAt: new Date('2026-10-30T12:00:00Z'),
    description: 'Pedido #ABCDEF — Mercado Pago 1',
    referenceType: CashReferenceType.PAYMENT,
    referenceId: 'pay-1',
    reversesMovementId: null,
    createdByUserId: null,
    createdAt: new Date('2026-10-30T12:00:00Z'),
    ...over,
  }) as CashMovement;

const extra = {
  cashBoxName: 'Mercado Pago',
  categoryName: 'Cobro de pedido',
  reversed: false,
};

describe('movimientos de caja en la API v2', () => {
  it('el listado v2 es `/cash-movements` versión 2 y el v1 sigue sin versión', () => {
    expect(
      Reflect.getMetadata(VERSION_METADATA, CashMovementV2Controller),
    ).toBe('2');
    expect(Reflect.getMetadata(PATH_METADATA, CashMovementV2Controller)).toBe(
      'cash-movements',
    );
    expect(
      Reflect.getMetadata(VERSION_METADATA, CashMovementController),
    ).toBeUndefined();
  });

  it('la v1 está congelada: no trae `orderId`; la v2 sí', () => {
    const m = movimiento();
    expect(CashMapper.movimiento(m, extra)).not.toHaveProperty('orderId');
    expect(
      CashMapper.movimientoV2(m, { ...extra, orderId: 'ord-1' }),
    ).toMatchObject({
      movementId: 'm-1',
      orderId: 'ord-1',
    });
    expect(CashMapper.movimientoV2(m, extra).orderId).toBeNull();
  });

  it('el listado v2 consulta con los mismos filtros y devuelve el pedido de cada cobro; sin autor, null', async () => {
    const consultar = jest.fn().mockResolvedValue({
      data: [{ movimiento: movimiento(), ...extra, orderId: 'ord-1' }],
      total: 1,
    });
    const controller = new CashMovementV2Controller({ consultar } as never);

    const page = await controller.findAll(
      { cashBoxId: 'c-1' } as never,
      'dist-1',
    );

    expect(consultar).toHaveBeenCalledWith('dist-1', { cashBoxId: 'c-1' });
    expect(page.total).toBe(1);
    expect(page.data[0]).toMatchObject({
      orderId: 'ord-1',
      createdByUserId: null,
    });
  });
});
