import type { DataSource, EntityManager } from 'typeorm';
import { MpLedgerReader } from './mp-ledger.reader';

const DIST = 'dist-1';

/** Un `manager` cuyo `query` contesta según un pedazo del SQL. */
const managerCon = (respuestas: Array<[RegExp, unknown[]]>) => {
  const query = jest.fn((sql: string): Promise<unknown[]> => {
    const hallada = respuestas.find(([patron]) => patron.test(sql));
    return Promise.resolve(hallada ? hallada[1] : []);
  });
  return { manager: { query } as unknown as EntityManager, query };
};

describe('MpLedgerReader', () => {
  const reader = new MpLedgerReader({} as DataSource);

  it('separa los pagos de la distribuidora de los de otras y arma su estado en el libro', async () => {
    const { manager } = managerCon([
      [
        /FROM "payment"\s+WHERE "gateway"/,
        [
          {
            payment_id: 'p-1',
            order_id: 'o-1',
            gateway_payment_id: 'MP-1',
            distributor_id: DIST,
          },
          {
            payment_id: 'p-2',
            order_id: 'o-2',
            gateway_payment_id: 'MP-2',
            distributor_id: 'otra',
          },
          {
            payment_id: 'p-3',
            order_id: 'o-3',
            gateway_payment_id: 'MP-3',
            distributor_id: null,
          },
        ],
      ],
      [
        /"reference_type" = \$2/,
        [
          {
            reference_id: 'p-1',
            cash_box_id: 'w-1',
            amount: '1000.00',
            occurred_at: new Date('2026-10-02T13:00:00Z'),
          },
        ],
      ],
      [/SELECT SUM\(r\."amount"\)/, [{ payment_id: 'p-1', total: '400.00' }]],
    ]);

    const { propios, ajenos, sinDistribuidora } = await reader.pagosDeLosIds(
      manager,
      DIST,
      ['MP-1', 'MP-2', 'MP-3', 'MP-4'],
    );

    expect([...propios.keys()]).toEqual(['MP-1']);
    expect([...ajenos]).toEqual(['MP-2']);
    expect([...sinDistribuidora]).toEqual(['MP-3']);
    const pago = propios.get('MP-1');
    expect(pago?.ingreso?.amount.toNumber()).toBe(1000);
    expect(pago?.ingreso?.cashBoxId).toBe('w-1');
    expect(pago?.devolucionComprometida.toNumber()).toBe(400);
  });

  it('sin ids no consulta nada', async () => {
    const { manager, query } = managerCon([]);

    const r = await reader.pagosDeLosIds(manager, DIST, []);

    expect(r.propios.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('la comisión de un cobro suma los ajustes que ya se asentaron desde una conciliación', async () => {
    const { manager } = managerCon([
      [
        /FROM "payment"\s+WHERE "gateway"/,
        [
          {
            payment_id: 'p-1',
            order_id: 'o-1',
            gateway_payment_id: 'MP-1',
            distributor_id: DIST,
          },
        ],
      ],
      [
        /"reference_type" = \$2/,
        [
          {
            reference_id: 'p-1',
            cash_box_id: 'w-1',
            amount: '900.00',
            occurred_at: new Date(),
          },
        ],
      ],
      [
        /FROM "mp_reconciliation_item"/,
        [{ payment_id: 'p-1', total: '100.00' }],
      ],
    ]);

    const { propios } = await reader.pagosDeLosIds(manager, DIST, ['MP-1']);

    // Los mismos datos de `reference_type = $2` sirven de ingreso y de comisión en este mock.
    expect(propios.get('MP-1')?.comision?.toNumber()).toBe(1000);
  });

  it('los ingresos del rango y el saldo de la caja salen del libro', async () => {
    const { manager } = managerCon([
      [
        /FROM "payment" p\s+WHERE p\."distributor_id"/,
        [
          {
            payment_id: 'p-1',
            order_id: 'o-1',
            gateway_payment_id: 'MP-1',
            distributor_id: DIST,
          },
        ],
      ],
      [
        /GROUP BY "direction"/,
        [
          { direction: 'in', total: '500.00' },
          { direction: 'out', total: '120.50' },
        ],
      ],
    ]);

    const pagos = await reader.ingresosDelRango(
      manager,
      DIST,
      new Date('2026-10-01T03:00:00Z'),
      new Date('2026-11-01T03:00:00Z'),
    );
    const caja = await reader.movimientosDeLaCaja(
      manager,
      DIST,
      'w-1',
      new Date(),
      new Date(),
    );

    expect(pagos.map((p) => p.gatewayPaymentId)).toEqual(['MP-1']);
    expect(caja.income.toNumber()).toBe(500);
    expect(caja.expense.toNumber()).toBe(120.5);
  });
});
