import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { SupplierService } from '../../purchase/application/supplier.service';
import { StockAdjustmentUseCase } from '../../stock/application/stock-adjustment.use-case';
import { StockQueryService } from '../../stock/application/stock-query.service';
import { WarehouseService } from '../../stock/application/warehouse.service';
import { StockInsuficienteError } from '../../stock/domain/errors/stock.errors';
import { StockCondition } from '../../stock/domain/stock.enums';
import { Warehouse } from '../../stock/entities/warehouse.entity';
import {
  ColumnaDeImportacion,
  ContextoDeAplicacion,
  FilaCruda,
  ImportHandler,
} from '../domain/import.types';
import { GarrafasImportHandler } from './garrafas.handler';
import { PreciosImportHandler } from './precios.handler';
import { ProveedoresImportHandler } from './proveedores.handler';
import { StockImportHandler } from './stock.handler';

const manager = {} as EntityManager;
const ctx: ContextoDeAplicacion = {
  distributorId: 'd1',
  actorUserId: 'u1',
  importId: 'i1',
  fileName: 'carga.xlsx',
};

const garrafa = (
  id: string,
  type: string,
  price = 1000,
  isActive = true,
): GasCylinder =>
  ({ gasCylinderId: id, type, price, isActive }) as unknown as GasCylinder;

/** Una fila cruda con todas las columnas, vacías salvo lo que se pasa. */
const fila = (
  numero: number,
  columnas: ColumnaDeImportacion[],
  valores: Record<string, string>,
): FilaCruda => ({
  fila: numero,
  celdas: Object.fromEntries(
    columnas.map((c) => [c.key, valores[c.key] ?? '']),
  ),
});

/** La fila de ejemplo de la plantilla, tal cual sale. */
const ejemplo = (h: ImportHandler): FilaCruda =>
  fila(
    2,
    h.columnas,
    Object.fromEntries(h.columnas.map((c) => [c.key, c.ejemplo])),
  );

describe('GarrafasImportHandler', () => {
  let service: {
    tiposDelCatalogo: jest.Mock;
    crearEn: jest.Mock;
  };
  let handler: GarrafasImportHandler;

  beforeEach(() => {
    service = {
      tiposDelCatalogo: jest.fn().mockResolvedValue([garrafa('g0', '45 kg')]),
      crearEn: jest.fn().mockResolvedValue(undefined),
    };
    handler = new GarrafasImportHandler(
      service as unknown as GasCylinderService,
    );
  });

  it('la fila de ejemplo de la plantilla es válida', async () => {
    const r = await handler.validar([ejemplo(handler)], 'd1');
    expect(r.errores).toEqual([]);
    expect(r.filas[0].datos).toMatchObject({
      type: '10 kg',
      weight: 10,
      price: 12500.5,
    });
  });

  it('normaliza coma decimal y deja el stock en 0 si no viene', async () => {
    const r = await handler.validar(
      [
        fila(2, handler.columnas, {
          type: ' 15 kg ',
          weight: '15',
          price: '1.250,75',
        }),
      ],
      'd1',
    );
    expect(r.filas).toEqual([
      {
        fila: 2,
        datos: {
          type: '15 kg',
          weight: 15,
          price: 1250.75,
          stock: 0,
          description: null,
        },
      },
    ]);
  });

  it('marca cada error con su fila y columna, sin repetir el del número mal escrito', async () => {
    const r = await handler.validar(
      [
        fila(2, handler.columnas, {
          type: '10 kg',
          weight: 'diez',
          price: '100',
        }),
        fila(3, handler.columnas, { type: '12 kg', weight: '12', price: '0' }),
        fila(4, handler.columnas, { type: '', weight: '1', price: '1' }),
        fila(5, handler.columnas, {
          type: '20 kg',
          weight: '20',
          price: '10',
          stock: '2,5',
        }),
      ],
      'd1',
    );
    expect(r.filas).toEqual([]);
    expect(r.errores).toEqual([
      { fila: 2, columna: 'Peso (kg)', mensaje: '"diez" no es un número' },
      { fila: 3, columna: 'Precio', mensaje: 'Precio debe ser mayor que 0' },
      { fila: 4, columna: 'Tipo', mensaje: 'es obligatorio' },
      {
        fila: 5,
        columna: 'Stock inicial',
        mensaje: 'Stock inicial debe ser un número entero',
      },
    ]);
  });

  it('rechaza el tipo repetido en el archivo y el que ya existe, sin distinguir mayúsculas', async () => {
    const base = { weight: '10', price: '100' };
    const r = await handler.validar(
      [
        fila(2, handler.columnas, { ...base, type: '10 kg' }),
        fila(3, handler.columnas, { ...base, type: ' 10 KG' }),
        fila(4, handler.columnas, { ...base, type: '45 KG' }),
      ],
      'd1',
    );
    expect(r.filas.map((f) => f.fila)).toEqual([2]);
    expect(r.errores).toEqual([
      {
        fila: 3,
        columna: 'Tipo',
        mensaje: 'El tipo está repetido en el archivo (ya figura en la fila 2)',
      },
      {
        fila: 4,
        columna: 'Tipo',
        mensaje: 'Ya existe una garrafa con este tipo en tu distribuidora',
      },
    ]);
  });

  it('aplica fila por fila con el alta unitaria y cuenta lo creado', async () => {
    const r = await handler.aplicar(
      manager,
      [
        {
          fila: 2,
          datos: {
            type: '10 kg',
            weight: 10,
            price: 100,
            stock: 3,
            description: null,
          },
        },
      ],
      ctx,
    );
    expect(r).toEqual({ creadas: 1 });
    expect(service.crearEn).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ type: '10 kg', stock: 3 }),
      'd1',
    );
  });

  it('si una fila falla, el error dice cuál', async () => {
    service.crearEn
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BadRequestException('Ya existe una garrafa'));
    const filas = [2, 3].map((n) => ({
      fila: n,
      datos: {
        type: `T${n}`,
        weight: 1,
        price: 1,
        stock: 0,
        description: null,
      },
    }));
    await expect(handler.aplicar(manager, filas, ctx)).rejects.toThrow(
      'Fila 3: Ya existe una garrafa',
    );
  });
});

describe('PreciosImportHandler', () => {
  let service: { tiposDelCatalogo: jest.Mock; cambiarPrecioEn: jest.Mock };
  let handler: PreciosImportHandler;

  beforeEach(() => {
    service = {
      tiposDelCatalogo: jest
        .fn()
        .mockResolvedValue([
          garrafa('g1', '10 kg', 1000),
          garrafa('g2', '15 kg', 2000),
          garrafa('g3', '45 kg', 3000, false),
        ]),
      cambiarPrecioEn: jest.fn().mockResolvedValue(true),
    };
    handler = new PreciosImportHandler(
      service as unknown as GasCylinderService,
    );
  });

  it('la fila de ejemplo de la plantilla es válida', async () => {
    const r = await handler.validar([ejemplo(handler)], 'd1');
    expect(r.errores).toEqual([]);
    expect(r.filas[0].datos).toEqual({
      gasCylinderId: 'g1',
      type: '10 kg',
      price: 13000,
      previousPrice: 1000,
    });
  });

  it('valida tipo inexistente, dado de baja, repetido, vacío y precio inválido', async () => {
    const r = await handler.validar(
      [
        fila(2, handler.columnas, { type: '10 kg', price: '1100' }),
        fila(3, handler.columnas, { type: '99 kg', price: '5' }),
        fila(4, handler.columnas, { type: '45 kg', price: '5' }),
        fila(5, handler.columnas, { type: '10 KG', price: '1200' }),
        fila(6, handler.columnas, { type: '', price: '1200' }),
        fila(7, handler.columnas, { type: '15 kg', price: '-1' }),
        fila(8, handler.columnas, { type: '15 kg', price: 'mucho' }),
      ],
      'd1',
    );
    expect(r.filas.map((f) => f.fila)).toEqual([2]);
    expect(r.errores).toEqual([
      {
        fila: 3,
        columna: 'Tipo',
        mensaje: 'No existe una garrafa con ese tipo en tu distribuidora',
      },
      {
        fila: 4,
        columna: 'Tipo',
        mensaje:
          'La garrafa está dada de baja: reactivala antes de cambiarle el precio',
      },
      {
        fila: 5,
        columna: 'Tipo',
        mensaje: 'El tipo está repetido en el archivo (ya figura en la fila 2)',
      },
      { fila: 6, columna: 'Tipo', mensaje: 'es obligatorio' },
      {
        fila: 7,
        columna: 'Precio nuevo',
        mensaje: 'Precio nuevo debe ser mayor que 0',
      },
      {
        fila: 8,
        columna: 'Precio nuevo',
        mensaje: '"mucho" no es un número',
      },
      {
        fila: 8,
        columna: 'Tipo',
        mensaje: 'El tipo está repetido en el archivo (ya figura en la fila 7)',
      },
    ]);
  });

  it('aplica en orden de id (orden global de locks) y separa lo que no cambió', async () => {
    service.cambiarPrecioEn.mockImplementation((_m: unknown, id: string) =>
      Promise.resolve(id !== 'g1'),
    );
    const r = await handler.aplicar(
      manager,
      [
        {
          fila: 2,
          datos: {
            gasCylinderId: 'g2',
            type: '15 kg',
            price: 5,
            previousPrice: 1,
          },
        },
        {
          fila: 3,
          datos: {
            gasCylinderId: 'g1',
            type: '10 kg',
            price: 6,
            previousPrice: 6,
          },
        },
      ],
      ctx,
    );
    expect(r).toEqual({ actualizadas: 1, sinCambio: 1 });
    expect(
      service.cambiarPrecioEn.mock.calls.map((c: unknown[]) => c[1]),
    ).toEqual(['g1', 'g2']);
  });

  it('si una falla, el error dice la fila', async () => {
    service.cambiarPrecioEn.mockRejectedValue(new BadRequestException('boom'));
    await expect(
      handler.aplicar(
        manager,
        [
          {
            fila: 9,
            datos: {
              gasCylinderId: 'g1',
              type: 'x',
              price: 1,
              previousPrice: 1,
            },
          },
        ],
        ctx,
      ),
    ).rejects.toThrow('Fila 9: boom');
  });
});

describe('ProveedoresImportHandler', () => {
  let service: { cuitsVigentes: jest.Mock; crearEn: jest.Mock };
  let handler: ProveedoresImportHandler;

  beforeEach(() => {
    service = {
      cuitsVigentes: jest.fn().mockResolvedValue(new Set(['30712345671'])),
      crearEn: jest.fn().mockResolvedValue(undefined),
    };
    handler = new ProveedoresImportHandler(
      service as unknown as SupplierService,
    );
  });

  const base = {
    businessName: 'Gas del Litoral',
    cuit: '30-70998877-4',
    kind: 'Planta fraccionadora',
  };

  it('la fila de ejemplo de la plantilla es válida', async () => {
    const r = await handler.validar([ejemplo(handler)], 'd1');
    expect(r.errores).toEqual([]);
    expect(r.filas[0].datos).toMatchObject({
      cuit: '30715123459',
      kind: 'filling_plant',
      paymentTermsDays: 30,
    });
  });

  it('normaliza CUIT y tipo, y los opcionales vacíos quedan en null', async () => {
    const r = await handler.validar([fila(2, handler.columnas, base)], 'd1');
    expect(r.filas[0].datos).toEqual({
      businessName: 'Gas del Litoral',
      cuit: '30709988774',
      kind: 'filling_plant',
      contactName: null,
      phone: null,
      email: null,
      address: null,
      paymentTermsDays: null,
    });
  });

  it('valida CUIT inválido o repetido, tipo desconocido, email y plazo', async () => {
    const r = await handler.validar(
      [
        fila(2, handler.columnas, base),
        fila(3, handler.columnas, { ...base, cuit: '30709988774' }),
        fila(4, handler.columnas, { ...base, cuit: '30-71234567-1' }),
        fila(5, handler.columnas, { ...base, cuit: '11111111111' }),
        fila(6, handler.columnas, {
          ...base,
          cuit: '20-12345678-6',
          kind: 'mayorista',
        }),
        fila(7, handler.columnas, {
          ...base,
          cuit: '20-12345678-6',
          email: 'x',
          paymentTermsDays: '400',
        }),
        fila(8, handler.columnas, {
          ...base,
          cuit: '20-12345678-6',
          paymentTermsDays: 'x',
        }),
      ],
      'd1',
    );
    expect(r.filas.map((f) => f.fila)).toEqual([2]);
    expect(r.errores).toEqual([
      {
        fila: 3,
        columna: 'CUIT',
        mensaje: 'El CUIT está repetido en el archivo (ya figura en la fila 2)',
      },
      {
        fila: 4,
        columna: 'CUIT',
        mensaje: 'Ya hay un proveedor vigente con el CUIT 30712345671',
      },
      {
        fila: 5,
        columna: 'CUIT',
        mensaje: 'CUIT: no es un CUIT válido (11 dígitos y dígito verificador)',
      },
      {
        fila: 6,
        columna: 'Tipo',
        mensaje:
          '"mayorista" no es un tipo válido: usá "planta fraccionadora" u "otro"',
      },
      { fila: 7, columna: 'Email', mensaje: 'no es un email válido' },
      {
        fila: 7,
        columna: 'Plazo de pago (días)',
        mensaje: 'no puede ser mayor que 365',
      },
      {
        fila: 8,
        columna: 'Plazo de pago (días)',
        mensaje: '"x" no es un número',
      },
    ]);
  });

  it('aplica con el alta unitaria y, si una falla, dice la fila', async () => {
    const filas = [2, 3].map((n) => ({
      fila: n,
      datos: { ...base, kind: 'other', cuit: '30709988774' },
    }));
    await expect(handler.aplicar(manager, filas, ctx)).resolves.toEqual({
      creados: 2,
    });
    service.crearEn.mockRejectedValueOnce(
      new BadRequestException('cuit ya está'),
    );
    await expect(handler.aplicar(manager, filas, ctx)).rejects.toThrow(
      'Fila 2: cuit ya está',
    );
  });
});

const G1 = '00000000-0000-4000-8000-000000000001';
const G2 = '00000000-0000-4000-8000-000000000002';
const G3 = '00000000-0000-4000-8000-000000000003';

describe('StockImportHandler', () => {
  let garrafas: { tiposDelCatalogo: jest.Mock };
  let depositos: { findAll: jest.Mock };
  let ajustes: { ejecutarEn: jest.Mock };
  let saldos: { saldos: jest.Mock };
  let handler: StockImportHandler;

  const deposito = (id: string, code: string) => ({
    warehouse: { warehouseId: id, code } as Warehouse,
    locationId: 'l' + id,
  });

  beforeEach(() => {
    garrafas = {
      tiposDelCatalogo: jest
        .fn()
        .mockResolvedValue([
          garrafa(G1, '10 kg'),
          garrafa(G2, '15 kg'),
          garrafa(G3, '45 kg', 1, false),
        ]),
    };
    depositos = {
      findAll: jest
        .fn()
        .mockResolvedValue([
          deposito('w1', 'CENTRAL'),
          deposito('w2', 'NORTE'),
        ]),
    };
    ajustes = { ejecutarEn: jest.fn().mockResolvedValue('a1') };
    // Saldo holgado en todo, salvo «NORTE / 15 kg / vacía», que tiene 3.
    saldos = {
      saldos: jest.fn().mockResolvedValue(
        ['w1', 'w2'].flatMap((w) =>
          [G1, G2].flatMap((g) =>
            Object.values(StockCondition).map((condition) => ({
              warehouseId: w,
              gasCylinderId: g,
              condition,
              quantity:
                w === 'w2' && g === G2 && condition === StockCondition.EMPTY
                  ? 3
                  : 1000,
            })),
          ),
        ),
      ),
    };
    handler = new StockImportHandler(
      garrafas as unknown as GasCylinderService,
      depositos as unknown as WarehouseService,
      ajustes as unknown as StockAdjustmentUseCase,
      saldos as unknown as StockQueryService,
    );
  });

  it('marca en la vista previa la baja que dejaría el stock en negativo', async () => {
    const r = await handler.validar(
      [
        fila(2, handler.columnas, {
          warehouse: 'NORTE',
          type: '15 kg',
          condition: 'vacía',
          quantityDelta: '-5',
        }),
      ],
      'd1',
    );
    expect(r.filas).toEqual([]);
    expect(r.errores).toEqual([
      expect.objectContaining({
        fila: 2,
        mensaje: 'Dejaría el stock en negativo: hay 3 y la variación es -5',
      }),
    ]);
  });

  it('la fila de ejemplo de la plantilla es válida', async () => {
    const r = await handler.validar([ejemplo(handler)], 'd1');
    expect(r.errores).toEqual([]);
    expect(r.filas[0].datos).toEqual({
      warehouseId: 'w1',
      warehouse: 'CENTRAL',
      gasCylinderId: G1,
      type: '10 kg',
      condition: StockCondition.FULL,
      quantityDelta: 40,
    });
  });

  it('acepta las condiciones en castellano y en inglés, y variaciones negativas', async () => {
    const r = await handler.validar(
      [
        fila(2, handler.columnas, {
          warehouse: 'norte',
          type: '10 KG',
          condition: 'Vacías',
          quantityDelta: '-3',
        }),
        fila(3, handler.columnas, {
          warehouse: 'NORTE',
          type: '10 kg',
          condition: 'defective',
          quantityDelta: '2',
        }),
      ],
      'd1',
    );
    expect(r.errores).toEqual([]);
    expect(r.filas.map((f) => f.datos.condition)).toEqual([
      StockCondition.EMPTY,
      StockCondition.DEFECTIVE,
    ]);
  });

  it('marca depósito, tipo, condición y variación inválidos, y la fila duplicada', async () => {
    const ok = {
      warehouse: 'CENTRAL',
      type: '10 kg',
      condition: 'llena',
      quantityDelta: '5',
    };
    const r = await handler.validar(
      [
        fila(2, handler.columnas, ok),
        fila(3, handler.columnas, { ...ok, warehouse: 'SUR' }),
        fila(4, handler.columnas, { ...ok, type: '99 kg' }),
        fila(5, handler.columnas, { ...ok, type: '45 kg' }),
        fila(6, handler.columnas, { ...ok, condition: 'rota' }),
        fila(7, handler.columnas, {
          ...ok,
          condition: 'vacia',
          quantityDelta: '0',
        }),
        fila(8, handler.columnas, {
          ...ok,
          condition: 'defectuosa',
          quantityDelta: '1,5',
        }),
        fila(9, handler.columnas, ok),
        fila(10, handler.columnas, {
          warehouse: '',
          type: '',
          condition: '',
          quantityDelta: '',
        }),
      ],
      'd1',
    );
    expect(r.filas.map((f) => f.fila)).toEqual([2]);
    expect(r.errores).toEqual([
      {
        fila: 3,
        columna: 'Depósito',
        mensaje: 'No hay un depósito activo con el código "SUR"',
      },
      {
        fila: 4,
        columna: 'Tipo',
        mensaje: 'No existe una garrafa con ese tipo en tu distribuidora',
      },
      {
        fila: 5,
        columna: 'Tipo',
        mensaje:
          'La garrafa está dada de baja: reactivala antes de mover su stock',
      },
      {
        fila: 6,
        columna: 'Condición',
        mensaje:
          '"rota" no es una condición válida: usá llena, vacía o defectuosa',
      },
      {
        fila: 7,
        columna: 'Variación',
        mensaje:
          'La variación de cada ítem tiene que ser un entero distinto de cero',
      },
      {
        fila: 8,
        columna: 'Variación',
        mensaje: 'tiene que ser un número entero',
      },
      {
        fila: 9,
        columna: 'Tipo',
        mensaje:
          'Ya hay una fila para este depósito, tipo y condición (fila 2)',
      },
      { fila: 10, columna: 'Depósito', mensaje: 'es obligatorio' },
      { fila: 10, columna: 'Tipo', mensaje: 'es obligatorio' },
      { fila: 10, columna: 'Condición', mensaje: 'es obligatorio' },
      { fila: 10, columna: 'Variación', mensaje: 'es obligatorio' },
    ]);
  });

  const datos = (
    warehouseId: string,
    warehouse: string,
    gasCylinderId: string,
    quantityDelta: number,
  ) => ({
    warehouseId,
    warehouse,
    gasCylinderId,
    type: 'x',
    condition: StockCondition.FULL,
    quantityDelta,
  });

  it('agrupa por depósito y aplica un ajuste de conteo por grupo', async () => {
    const r = await handler.aplicar(
      manager,
      [
        { fila: 2, datos: datos('w1', 'CENTRAL', G1, 5) },
        { fila: 3, datos: datos('w2', 'NORTE', G1, -1) },
        { fila: 4, datos: datos('w1', 'CENTRAL', G2, 7) },
      ],
      ctx,
    );
    expect(r).toEqual({ filasAplicadas: 3, ajustes: 2, depositos: 2 });
    expect(ajustes.ejecutarEn).toHaveBeenCalledTimes(2);
    expect(ajustes.ejecutarEn).toHaveBeenNthCalledWith(
      1,
      manager,
      expect.objectContaining({
        location: { warehouseId: 'w1' },
        reason: 'count_correction',
        notes: 'Importación masiva de stock (carga.xlsx)',
        items: [
          expect.objectContaining({ gasCylinderId: G1, quantityDelta: 5 }),
          expect.objectContaining({ gasCylinderId: G2, quantityDelta: 7 }),
        ],
      }),
      'd1',
      'u1',
    );
  });

  it('parte en ajustes de hasta 50 renglones, como el alta unitaria', async () => {
    const filas = Array.from({ length: 120 }, (_, i) => ({
      fila: i + 2,
      datos: datos(
        'w1',
        'CENTRAL',
        `${G1.slice(0, 24)}${String(i).padStart(12, '0')}`,
        1,
      ),
    }));
    const r = await handler.aplicar(manager, filas, ctx);
    expect(r.ajustes).toBe(3);
    expect(
      ajustes.ejecutarEn.mock.calls.map(
        (c: [unknown, { items: unknown[] }]) => c[1].items.length,
      ),
    ).toEqual([50, 50, 20]);
  });

  it('si el stock no alcanza, el error nombra el depósito', async () => {
    ajustes.ejecutarEn.mockRejectedValue(
      new StockInsuficienteError([
        {
          locationId: 'lw1',
          locationLabel: 'Depósito central',
          gasCylinderId: G1,
          gasCylinderType: '10 kg',
          condition: StockCondition.FULL,
          available: 1,
          requested: 5,
        },
      ]),
    );
    await expect(
      handler.aplicar(
        manager,
        [{ fila: 2, datos: datos('w1', 'CENTRAL', G1, -5) }],
        ctx,
      ),
    ).rejects.toThrow(/^Depósito CENTRAL: Stock insuficiente/);
  });
});
