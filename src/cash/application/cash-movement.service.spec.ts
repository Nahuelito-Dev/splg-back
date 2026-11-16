import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CashDirection, CashReferenceType } from '../domain/cash.enums';
import { MovimientoInvalidoError } from '../domain/errors/cash.errors';
import { CashMovement } from '../entities/cash-movement.entity';
import { CashCategoryService } from './cash-category.service';
import { CashLedgerService, RegistrarMovimiento } from './cash-ledger.service';
import { CashMovementService } from './cash-movement.service';

const mov = (parcial: Partial<CashMovement>): CashMovement =>
  ({
    movementId: 'm-1',
    distributorId: 'dist-1',
    cashBoxId: 'caja-1',
    direction: CashDirection.IN,
    amount: 100,
    categoryId: 'cat-1',
    method: 'cash',
    referenceType: CashReferenceType.MANUAL,
    referenceId: null,
    reversesMovementId: null,
    ...parcial,
  }) as CashMovement;

describe('CashMovementService', () => {
  let movimientos: CashMovement[];
  let yaAnulado: boolean;
  let registrados: RegistrarMovimiento[];
  let bloqueos: string[][];
  let consultas: Array<{ sql: string; params: unknown[] }>;
  let servicio: CashMovementService;

  beforeEach(() => {
    movimientos = [];
    yaAnulado = false;
    registrados = [];
    bloqueos = [];
    consultas = [];
    const manager = {
      findOne: jest.fn(
        (_: unknown, { where }: { where: Partial<CashMovement> }) =>
          Promise.resolve(
            movimientos.find((m) =>
              Object.entries(where).every(
                ([k, v]) => m[k as keyof CashMovement] === v,
              ),
            ) ?? null,
          ),
      ),
      exists: jest.fn(() => Promise.resolve(yaAnulado)),
      query: jest.fn(),
    } as unknown as EntityManager;
    const dataSource = {
      transaction: (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      query: jest.fn((sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        return Promise.resolve([{ entradas: '0', salidas: '0', cantidad: 0 }]);
      }),
      manager: {
        findBy: jest.fn(() => Promise.resolve([])),
        query: jest.fn(() => Promise.resolve([])),
      },
    } as unknown as DataSource;
    const ledger = {
      bloquearCajas: jest.fn((_m: unknown, ids: string[]) => {
        bloqueos.push(ids);
        return Promise.resolve();
      }),
      registrar: jest.fn((_m: unknown, entrada: RegistrarMovimiento) => {
        registrados.push(entrada);
        return Promise.resolve(
          mov({
            movementId: `r-${registrados.length}`,
            cashBoxId: entrada.cashBoxId,
            direction: entrada.direction,
          }),
        );
      }),
    } as unknown as CashLedgerService;
    servicio = new CashMovementService(
      dataSource,
      ledger,
      {} as unknown as CashCategoryService,
    );
  });

  describe('anular (CU-229)', () => {
    it('anula un movimiento manual con el contraasiento', async () => {
      movimientos = [mov({})];
      await servicio.anular('m-1', 'Se cargó dos veces', 'dist-1', 'u-1');
      expect(registrados).toHaveLength(1);
      expect(registrados[0]).toMatchObject({
        direction: CashDirection.OUT,
        reversesMovementId: 'm-1',
        referenceType: CashReferenceType.REVERSAL,
        esContraasiento: true,
      });
    });

    it.each([
      CashReferenceType.BOX_TRANSFER,
      CashReferenceType.DRIVER_LIQUIDATION,
      CashReferenceType.CUSTOMER_PAYMENT,
      CashReferenceType.DRIVER_SETTLEMENT,
      CashReferenceType.SESSION_OPENING,
      CashReferenceType.SESSION_CLOSING,
    ])('rechaza con 400 un movimiento %s y no asienta nada', async (tipo) => {
      movimientos = [mov({ referenceType: tipo })];
      await expect(
        servicio.anular('m-1', 'x', 'dist-1', 'u-1'),
      ).rejects.toBeInstanceOf(MovimientoInvalidoError);
      expect(registrados).toHaveLength(0);
    });

    it('409 si ya fue anulado', async () => {
      movimientos = [mov({})];
      yaAnulado = true;
      await expect(
        servicio.anular('m-1', 'x', 'dist-1', 'u-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(registrados).toHaveLength(0);
    });

    it('404 si es de otra distribuidora', async () => {
      movimientos = [mov({ distributorId: 'dist-2' })];
      await expect(
        servicio.anular('m-1', 'x', 'dist-1', 'u-1'),
      ).rejects.toThrow('no encontrado');
    });
  });

  describe('anularTransferencia (CU-310)', () => {
    const salida = mov({
      movementId: 'sal',
      cashBoxId: 'caja-b',
      direction: CashDirection.OUT,
      referenceType: CashReferenceType.BOX_TRANSFER,
      categoryId: 'cat-out',
    });
    const entrada = mov({
      movementId: 'ent',
      cashBoxId: 'caja-a',
      direction: CashDirection.IN,
      referenceType: CashReferenceType.BOX_TRANSFER,
      referenceId: 'sal',
      categoryId: 'cat-in',
    });

    it.each(['sal', 'ent'])(
      'revierte las dos patas juntas pidiéndolo por %s, con las dos cajas bloqueadas',
      async (pedida) => {
        movimientos = [salida, entrada];
        const r = await servicio.anularTransferencia(
          pedida,
          'Error de carga',
          'dist-1',
          'u-1',
        );
        expect(bloqueos).toEqual([['caja-b', 'caja-a']]);
        // primero el destino (puede no alcanzar), después el origen
        expect(registrados.map((x) => [x.cashBoxId, x.direction])).toEqual([
          ['caja-a', CashDirection.OUT],
          ['caja-b', CashDirection.IN],
        ]);
        expect(registrados.map((x) => x.reversesMovementId)).toEqual([
          'ent',
          'sal',
        ]);
        expect(r.out.movimiento.cashBoxId).toBe('caja-b');
        expect(r.in.movimiento.cashBoxId).toBe('caja-a');
      },
    );

    it('409 si ya se anuló y no asienta nada', async () => {
      movimientos = [salida, entrada];
      yaAnulado = true;
      await expect(
        servicio.anularTransferencia('sal', 'x', 'dist-1', 'u-1'),
      ).rejects.toThrow('ya fue anulada');
      expect(registrados).toHaveLength(0);
    });

    it('400 si el movimiento no es una transferencia', async () => {
      movimientos = [mov({})];
      await expect(
        servicio.anularTransferencia('m-1', 'x', 'dist-1', 'u-1'),
      ).rejects.toBeInstanceOf(MovimientoInvalidoError);
    });

    it('404 si es de otra distribuidora', async () => {
      movimientos = [
        { ...salida, distributorId: 'dist-2' } as CashMovement,
        { ...entrada, distributorId: 'dist-2' } as CashMovement,
      ];
      await expect(
        servicio.anularTransferencia('sal', 'x', 'dist-1', 'u-1'),
      ).rejects.toThrow('no encontrado');
    });
  });

  describe('totalesDelDia (CU-245)', () => {
    it('no cuenta los movimientos anulados ni sus anulaciones ni las transferencias', async () => {
      await servicio.totalesDelDia('dist-1', '2026-10-17');
      const sql = consultas[0].sql.replace(/\s+/g, ' ');
      expect(sql).toContain("NOT IN ('box_transfer', 'reversal')");
      expect(sql).toMatch(
        /NOT EXISTS \( SELECT 1 FROM "cash_movement" r WHERE r\."reverses_movement_id" = m\."movement_id"\)/,
      );
    });
  });
});
