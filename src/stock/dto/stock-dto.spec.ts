import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateAdjustmentDto,
  CreateInitialCountDto,
  CreateTransferDto,
} from './stock-operations.dto';
import { QueryStockMovementDto } from './query-stock.dto';
import { UpsertThresholdsDto } from './stock-threshold.dto';
import { CreateWarehouseDto } from './warehouse.dto';

const U1 = '10000000-0000-4000-8000-000000000001';
const U2 = '20000000-0000-4000-8000-000000000002';

async function errores<T extends object>(clase: new () => T, plano: object) {
  const dto = plainToInstance(clase, plano);
  return (
    await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
  ).map((e) => e.property);
}

const ajuste = {
  location: { warehouseId: U1 },
  reason: 'shrinkage',
  notes: 'dos con la válvula floja',
  items: [{ gasCylinderId: U2, condition: 'full', quantityDelta: -2 }],
};

describe('CreateAdjustmentDto', () => {
  it('acepta un ajuste completo', async () => {
    expect(await errores(CreateAdjustmentDto, ajuste)).toEqual([]);
  });

  it.each([undefined, '', '    '])(
    'la nota es obligatoria (%p)',
    async (notes) => {
      expect(
        await errores(CreateAdjustmentDto, { ...ajuste, notes }),
      ).toContain('notes');
    },
  );

  it('initial_count no es un motivo que se pueda elegir en un ajuste', async () => {
    expect(
      await errores(CreateAdjustmentDto, {
        ...ajuste,
        reason: 'initial_count',
      }),
    ).toContain('reason');
  });

  it.each([
    'count_correction',
    'shrinkage',
    'leak',
    'damaged',
    'lost',
    'found',
  ])('acepta el motivo %s', async (reason) => {
    expect(await errores(CreateAdjustmentDto, { ...ajuste, reason })).toEqual(
      [],
    );
  });

  it('rechaza ítems vacíos, variaciones no enteras y garrafas que no son uuid', async () => {
    expect(
      await errores(CreateAdjustmentDto, { ...ajuste, items: [] }),
    ).toContain('items');
    expect(
      await errores(CreateAdjustmentDto, {
        ...ajuste,
        items: [{ gasCylinderId: U2, condition: 'full', quantityDelta: 1.5 }],
      }),
    ).toContain('items');
    expect(
      await errores(CreateAdjustmentDto, {
        ...ajuste,
        items: [
          { gasCylinderId: 'no-uuid', condition: 'full', quantityDelta: 1 },
        ],
      }),
    ).toContain('items');
  });

  it('no deja pasar propiedades de más', async () => {
    expect(
      await errores(CreateAdjustmentDto, { ...ajuste, distributorId: U1 }),
    ).toContain('distributorId');
  });
});

describe('CreateTransferDto', () => {
  const t = {
    from: { warehouseId: U1 },
    to: { carId: U2 },
    items: [{ gasCylinderId: U2, quantity: 5 }],
  };
  it('acepta una transferencia', async () => {
    expect(await errores(CreateTransferDto, t)).toEqual([]);
  });
  it.each([0, -3, 2.5])('rechaza la cantidad %p', async (quantity) => {
    expect(
      await errores(CreateTransferDto, {
        ...t,
        items: [{ gasCylinderId: U2, quantity }],
      }),
    ).toContain('items');
  });
});

describe('CreateInitialCountDto', () => {
  it('acepta llenas obligatorias y vacías/defectuosas opcionales', async () => {
    expect(
      await errores(CreateInitialCountDto, {
        warehouseId: U1,
        items: [{ gasCylinderId: U2, full: 10 }],
      }),
    ).toEqual([]);
  });
  it('no admite negativos', async () => {
    expect(
      await errores(CreateInitialCountDto, {
        warehouseId: U1,
        items: [{ gasCylinderId: U2, full: -1 }],
      }),
    ).toContain('items');
  });
});

describe('otros DTOs', () => {
  it('el código del depósito se normaliza a mayúsculas y se valida', async () => {
    const ok = plainToInstance(CreateWarehouseDto, {
      name: 'Sucursal',
      code: ' suc-1 ',
    });
    expect(ok.code).toBe('SUC-1');
    expect(
      await errores(CreateWarehouseDto, { name: 'x', code: 'con espacios' }),
    ).toContain('code');
    expect(
      await errores(CreateWarehouseDto, { name: '   ', code: 'A' }),
    ).toContain('name');
  });

  it('el libro valida las fechas como YYYY-MM-DD', async () => {
    expect(
      await errores(QueryStockMovementDto, {
        from: '2026-10-01',
        to: '2026-10-11',
      }),
    ).toEqual([]);
    expect(
      await errores(QueryStockMovementDto, { from: '01/10/2026' }),
    ).toContain('from');
    expect(
      await errores(QueryStockMovementDto, { to: '2026-02-31' }),
    ).toContain('to');
  });

  it('los mínimos no pueden ser negativos', async () => {
    const ok = {
      thresholds: [{ warehouseId: U1, gasCylinderId: U2, minFull: 0 }],
    };
    expect(await errores(UpsertThresholdsDto, ok)).toEqual([]);
    expect(
      await errores(UpsertThresholdsDto, {
        thresholds: [{ warehouseId: U1, gasCylinderId: U2, minFull: -1 }],
      }),
    ).toContain('thresholds');
  });
});
