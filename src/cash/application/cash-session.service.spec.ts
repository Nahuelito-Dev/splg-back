import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { CashDirection, CashSessionStatus } from '../domain/cash.enums';
import { SesionNoEncontradaError } from '../domain/errors/cash.errors';
import { CashSessionService } from './cash-session.service';
import type { CashCategoryService } from './cash-category.service';
import type { CashLedgerService } from './cash-ledger.service';

describe('CashSessionService: el arqueo del cierre y su vista previa', () => {
  const abierta = (extra: Record<string, unknown> = {}) => ({
    sessionId: 's1',
    cashBoxId: 'c1',
    distributorId: 'd1',
    status: CashSessionStatus.OPEN,
    openingAmount: 5000,
    ...extra,
  });

  const armar = (fila: unknown, entradas: string, salidas: string) => {
    const query = jest
      .fn<Promise<unknown>, [string, unknown[]]>()
      .mockResolvedValue([
        { direction: CashDirection.IN, total: entradas },
        { direction: CashDirection.OUT, total: salidas },
      ]);
    const manager = {
      findOne: jest.fn().mockResolvedValue(fila),
      findOneByOrFail: jest
        .fn()
        .mockImplementation((entidad: { name: string }) =>
          Promise.resolve(
            entidad.name === 'CashBox' ? { name: 'Caja central' } : fila,
          ),
        ),
      query,
      save: jest.fn().mockImplementation((x: unknown) => Promise.resolve(x)),
    };
    const dataSource = {
      manager,
      transaction: (fn: (m: typeof manager) => unknown) => fn(manager),
    } as unknown as DataSource;
    const ledger = {
      bloquearCajas: jest.fn().mockResolvedValue(undefined),
      registrar: jest.fn().mockResolvedValue(undefined),
    };
    const categorias = {
      deSistema: jest.fn().mockResolvedValue({ categoryId: 'k1' }),
    };
    const servicio = new CashSessionService(
      dataSource,
      ledger as unknown as CashLedgerService,
      categorias as unknown as CashCategoryService,
    );
    return { servicio, manager, ledger };
  };

  it('devuelve lo esperado y la diferencia contado − esperado', async () => {
    const { servicio, manager } = armar(abierta(), '14000.10', '750');
    const r = await servicio.vistaPreviaDelCierre(
      's1',
      { countedAmount: 18000 },
      'd1',
    );
    expect(r).toEqual({
      openingAmount: 5000,
      totalIn: 14000.1,
      totalOut: 750,
      expectedAmount: 18250.1,
      countedAmount: 18000,
      difference: -250.1,
    });
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        where: { sessionId: 's1', distributorId: 'd1' },
      }),
    );
  });

  it('no cuenta el ajuste de apertura: el total sale de los movimientos que no son de apertura', async () => {
    const { servicio, manager } = armar(abierta(), '0', '0');
    await servicio.vistaPreviaDelCierre('s1', { countedAmount: 0 }, 'd1');
    expect(String(manager.query.mock.calls[0][0])).toContain(
      `"reference_type" <> 'session_opening'`,
    );
  });

  it('da la misma diferencia que asienta el cierre', async () => {
    const vista = armar(abierta(), '123.45', '20.10');
    const previa = await vista.servicio.vistaPreviaDelCierre(
      's1',
      { countedAmount: 5000 },
      'd1',
    );
    const cierre = armar(abierta(), '123.45', '20.10');
    const cerrada = await cierre.servicio.cerrar(
      's1',
      { countedAmount: 5000 },
      'd1',
      'u1',
    );
    expect(Number(cerrada.sesion.difference)).toBe(previa.difference);
    expect(Number(cerrada.sesion.expectedAmount)).toBe(previa.expectedAmount);
    expect(previa.difference).toBe(-103.35);
  });

  it('una sesión cerrada no se previsualiza (409)', async () => {
    const { servicio } = armar(
      abierta({ status: CashSessionStatus.CLOSED }),
      '0',
      '0',
    );
    await expect(
      servicio.vistaPreviaDelCierre('s1', { countedAmount: 0 }, 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una sesión de otra distribuidora (o inexistente) es 404', async () => {
    const { servicio } = armar(null, '0', '0');
    await expect(
      servicio.vistaPreviaDelCierre('s1', { countedAmount: 0 }, 'd2'),
    ).rejects.toBeInstanceOf(SesionNoEncontradaError);
  });
});
