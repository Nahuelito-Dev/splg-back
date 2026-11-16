import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  CashBoxKind,
  CashDirection,
  CashReferenceType,
  CategoryDirection,
} from '../domain/cash.enums';
import {
  CajaNoEncontradaError,
  CategoriaNoEncontradaError,
  MovimientoInvalidoError,
} from '../domain/errors/cash.errors';
import { CashLedgerService, RegistrarMovimiento } from './cash-ledger.service';

interface FilaCaja {
  cash_box_id: string;
  kind: CashBoxKind;
  balance: string;
  requires_session: boolean;
  is_active: boolean;
}

const caja = (parcial: Partial<FilaCaja> = {}): FilaCaja => ({
  cash_box_id: 'caja-1',
  kind: CashBoxKind.CASH,
  balance: '1000.00',
  requires_session: false,
  is_active: true,
  ...parcial,
});

describe('CashLedgerService', () => {
  let servicio: CashLedgerService;
  let consultas: Array<{ sql: string; params: unknown[] }>;
  let filaDeCaja: FilaCaja | undefined;
  let categoria: {
    categoryId: string;
    direction: CategoryDirection;
    isActive: boolean;
  } | null;
  let sesionAbierta: { sessionId: string } | null;
  let guardados: Array<Record<string, unknown>>;
  let manager: EntityManager;

  const base: RegistrarMovimiento = {
    distributorId: 'dist-1',
    cashBoxId: 'caja-1',
    direction: CashDirection.IN,
    amount: 250.5,
    categoryId: 'cat-1',
    description: 'Cobro',
    userId: 'user-1',
  };

  beforeEach(() => {
    servicio = new CashLedgerService();
    consultas = [];
    filaDeCaja = caja();
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.INCOME,
      isActive: true,
    };
    sesionAbierta = null;
    guardados = [];
    manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        if (sql.includes('FOR UPDATE')) {
          return Promise.resolve(filaDeCaja ? [filaDeCaja] : []);
        }
        return Promise.resolve([]);
      }),
      findOne: jest.fn((entidad: { name: string }) =>
        Promise.resolve(
          entidad.name === 'CashCategory' ? categoria : sesionAbierta,
        ),
      ),
      create: jest.fn((_e: unknown, datos: Record<string, unknown>) => datos),
      save: jest.fn((datos: Record<string, unknown>) => {
        guardados.push(datos);
        return Promise.resolve({ movementId: 'mov-1', ...datos });
      }),
    } as unknown as EntityManager;
  });

  const saldoGuardado = (): unknown =>
    consultas.find((c) => c.sql.includes('UPDATE "cash_box"'))?.params[0];

  it('una entrada suma al saldo y queda en el libro con quién la registró', async () => {
    const m = await servicio.registrar(manager, base);
    expect(saldoGuardado()).toBe(1250.5);
    expect(m).toMatchObject({
      cashBoxId: 'caja-1',
      direction: CashDirection.IN,
      amount: 250.5,
      referenceType: CashReferenceType.MANUAL,
      createdByUserId: 'user-1',
    });
  });

  it('una salida resta del saldo', async () => {
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.EXPENSE,
      isActive: true,
    };
    await servicio.registrar(manager, {
      ...base,
      direction: CashDirection.OUT,
      amount: 400.25,
    });
    expect(saldoGuardado()).toBe(599.75);
  });

  it('suma centavos sin errores de coma flotante', async () => {
    filaDeCaja = caja({ balance: '0.10' });
    await servicio.registrar(manager, { ...base, amount: 0.2 });
    expect(saldoGuardado()).toBe(0.3);
  });

  it('bloquea la caja de la distribuidora con FOR UPDATE antes de leerla', async () => {
    await servicio.registrar(manager, base);
    expect(consultas[0].sql).toContain('FOR UPDATE');
    expect(consultas[0].params).toEqual(['caja-1', 'dist-1']);
  });

  it('una caja de efectivo no puede quedar en negativo y no se escribe nada', async () => {
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.EXPENSE,
      isActive: true,
    };
    await expect(
      servicio.registrar(manager, {
        ...base,
        direction: CashDirection.OUT,
        amount: 1000.01,
      }),
    ).rejects.toThrow(ConflictException);
    expect(guardados).toHaveLength(0);
    expect(saldoGuardado()).toBeUndefined();
  });

  it('vaciar la caja justo es válido', async () => {
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.EXPENSE,
      isActive: true,
    };
    await servicio.registrar(manager, {
      ...base,
      direction: CashDirection.OUT,
      amount: 1000,
    });
    expect(saldoGuardado()).toBe(0);
  });

  it('una caja de banco sí puede quedar en negativo', async () => {
    filaDeCaja = caja({ kind: CashBoxKind.BANK, balance: '100.00' });
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.EXPENSE,
      isActive: true,
    };
    await servicio.registrar(manager, {
      ...base,
      direction: CashDirection.OUT,
      amount: 500,
    });
    expect(saldoGuardado()).toBe(-400);
  });

  it('exige que la categoría sea del mismo sentido que el movimiento', async () => {
    await expect(
      servicio.registrar(manager, { ...base, direction: CashDirection.OUT }),
    ).rejects.toThrow(MovimientoInvalidoError);
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.EXPENSE,
      isActive: true,
    };
    await expect(servicio.registrar(manager, base)).rejects.toThrow(
      MovimientoInvalidoError,
    );
  });

  it('una categoría desactivada no se usa en un movimiento nuevo (400)', async () => {
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.INCOME,
      isActive: false,
    };
    await expect(servicio.registrar(manager, base)).rejects.toThrow(
      'categoría está desactivada',
    );
    expect(guardados).toHaveLength(0);
  });

  it('pero un contraasiento sí puede usar la categoría desactivada del original', async () => {
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.INCOME,
      isActive: false,
    };
    await expect(
      servicio.registrar(manager, {
        ...base,
        direction: CashDirection.OUT,
        esContraasiento: true,
        reversesMovementId: 'mov-0',
      }),
    ).resolves.toBeDefined();
  });

  it('un contraasiento puede usar la categoría del original en sentido contrario', async () => {
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.INCOME,
      isActive: true,
    };
    await expect(
      servicio.registrar(manager, {
        ...base,
        direction: CashDirection.OUT,
        amount: 100,
        esContraasiento: true,
        reversesMovementId: 'mov-0',
      }),
    ).resolves.toBeDefined();
  });

  it('rechaza un importe que no es positivo, sin tocar la base', async () => {
    for (const amount of [0, -5, NaN]) {
      await expect(
        servicio.registrar(manager, { ...base, amount }),
      ).rejects.toThrow(MovimientoInvalidoError);
    }
    expect(consultas).toHaveLength(0);
  });

  it('caja o categoría de otra distribuidora: 404', async () => {
    filaDeCaja = undefined;
    await expect(servicio.registrar(manager, base)).rejects.toThrow(
      CajaNoEncontradaError,
    );
    filaDeCaja = caja();
    categoria = null;
    await expect(servicio.registrar(manager, base)).rejects.toThrow(
      CategoriaNoEncontradaError,
    );
  });

  it('una caja desactivada rechaza movimientos, salvo un contraasiento', async () => {
    filaDeCaja = caja({ is_active: false });
    await expect(servicio.registrar(manager, base)).rejects.toThrow(
      ConflictException,
    );
    categoria = {
      categoryId: 'cat-1',
      direction: CategoryDirection.EXPENSE,
      isActive: true,
    };
    await expect(
      servicio.registrar(manager, {
        ...base,
        direction: CashDirection.OUT,
        amount: 10,
        esContraasiento: true,
      }),
    ).resolves.toBeDefined();
  });

  describe('sesión', () => {
    it('una caja que la exige rechaza el movimiento sin sesión abierta (409)', async () => {
      filaDeCaja = caja({ requires_session: true });
      await expect(servicio.registrar(manager, base)).rejects.toThrow(
        ConflictException,
      );
      expect(guardados).toHaveLength(0);
    });

    it('con sesión abierta el movimiento queda en ella', async () => {
      filaDeCaja = caja({ requires_session: true });
      sesionAbierta = { sessionId: 'ses-1' };
      const m = await servicio.registrar(manager, base);
      expect(m).toMatchObject({ sessionId: 'ses-1' });
    });

    it('una anulación no exige sesión; si hay una, se le asigna', async () => {
      filaDeCaja = caja({ requires_session: true });
      categoria = {
        categoryId: 'cat-1',
        direction: CategoryDirection.INCOME,
        isActive: true,
      };
      const sin = await servicio.registrar(manager, {
        ...base,
        direction: CashDirection.OUT,
        esContraasiento: true,
      });
      expect(sin).toMatchObject({ sessionId: null });
      sesionAbierta = { sessionId: 'ses-9' };
      const con = await servicio.registrar(manager, {
        ...base,
        direction: CashDirection.OUT,
        esContraasiento: true,
      });
      expect(con).toMatchObject({ sessionId: 'ses-9' });
    });

    it('el ajuste de la propia sesión usa la que se le indica', async () => {
      filaDeCaja = caja({ requires_session: true });
      const m = await servicio.registrar(manager, {
        ...base,
        sessionId: 'ses-nueva',
      });
      expect(m).toMatchObject({ sessionId: 'ses-nueva' });
    });
  });

  describe('bloquearCajas', () => {
    it('las toma ordenadas por id y sin repetir', async () => {
      const query = jest
        .fn<Promise<unknown[]>, [string, unknown[]]>()
        .mockResolvedValue([{ cash_box_id: 'a' }, { cash_box_id: 'b' }]);
      manager = { query } as unknown as EntityManager;
      await servicio.bloquearCajas(manager, ['b', 'a', 'b'], 'dist-1');
      expect(query.mock.calls[0][1]).toEqual([['a', 'b'], 'dist-1']);
    });

    it('404 si alguna no existe o es de otra distribuidora', async () => {
      manager = {
        query: jest.fn().mockResolvedValue([{ cash_box_id: 'a' }]),
      } as unknown as EntityManager;
      await expect(
        servicio.bloquearCajas(manager, ['a', 'b'], 'dist-1'),
      ).rejects.toThrow(CajaNoEncontradaError);
    });
  });
});
