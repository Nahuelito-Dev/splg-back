import { AsientoAsentado } from '../application/customer-ledger.service';
import { CustomerEntryType } from '../domain/customer-account.enums';
import { CustomerAccountMapper } from './customer-account.mapper';

const asiento = {
  entry: {
    entryId: 'e-1',
    type: CustomerEntryType.PAYMENT,
    amount: 1000,
    occurredAt: new Date(),
  },
  balanceAfter: 42000,
  pendingAmount: 0,
} as unknown as AsientoAsentado;

describe('CustomerAccountMapper.asiento', () => {
  it('el administrador ve el saldo de la cuenta', () => {
    expect(CustomerAccountMapper.asiento(asiento).balanceAfter).toBe(42000);
  });

  it('al chofer no se le devuelve la deuda del cliente', () => {
    expect(
      CustomerAccountMapper.asiento(asiento, true).balanceAfter,
    ).toBeNull();
  });
});
