import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CashBoxKind } from '../domain/cash.enums';
import { CashBox } from '../entities/cash-box.entity';
import { CashBoxService } from './cash-box.service';
import { CashCategoryService } from './cash-category.service';

const caja = (parcial: Partial<CashBox>): CashBox =>
  ({
    cashBoxId: 'caja-1',
    name: 'Central',
    kind: CashBoxKind.CASH,
    balance: 0,
    isActive: true,
    requiresSession: false,
    ...parcial,
  }) as CashBox;

describe('CashBoxService', () => {
  let guardadas: CashBox[];
  let enBase: CashBox[];
  let servicio: CashBoxService;

  const montar = () => {
    const manager = {
      query: jest.fn(() => Promise.resolve([{ cash_box_id: 'caja-1' }])),
      findOneByOrFail: jest.fn(() => Promise.resolve(enBase[0])),
      findOne: jest.fn(() => Promise.resolve(null)),
      save: jest.fn((c: CashBox) => {
        guardadas.push(c);
        return Promise.resolve(c);
      }),
    } as unknown as EntityManager;
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(() => Promise.resolve([enBase, enBase.length])),
    };
    const repo = {
      createQueryBuilder: jest.fn(() => qb),
    } as unknown as Repository<CashBox>;
    const dataSource = {
      transaction: (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      query: jest.fn(() => Promise.resolve([])),
    } as unknown as DataSource;
    servicio = new CashBoxService(
      repo,
      dataSource,
      {} as unknown as CashCategoryService,
    );
    return qb;
  };

  beforeEach(() => {
    guardadas = [];
    enBase = [];
  });

  describe('desactivar (CU-264)', () => {
    it('409 si la caja tiene saldo distinto de cero', async () => {
      enBase = [caja({ balance: 1500.5 })];
      montar();
      await expect(
        servicio.update('caja-1', { isActive: false }, 'dist-1'),
      ).rejects.toThrow(ConflictException);
      expect(guardadas).toHaveLength(0);
    });

    it('409 también con saldo negativo (banco)', async () => {
      enBase = [caja({ kind: CashBoxKind.BANK, balance: -20 })];
      montar();
      await expect(
        servicio.update('caja-1', { isActive: false }, 'dist-1'),
      ).rejects.toThrow(/saldo/);
    });

    it('con saldo cero se desactiva', async () => {
      enBase = [caja({ balance: 0 })];
      montar();
      await servicio.update('caja-1', { isActive: false }, 'dist-1');
      expect(guardadas[0].isActive).toBe(false);
    });
  });

  describe('resumenParaTablero (CU-245)', () => {
    it('incluye las desactivadas que conservan saldo y deja afuera las vacías', async () => {
      enBase = [
        caja({ cashBoxId: 'a', balance: 100 }),
        caja({ cashBoxId: 'b', isActive: false, balance: 40 }),
        caja({ cashBoxId: 'c', isActive: false, balance: 0 }),
      ];
      const qb = montar();
      const filas = await servicio.resumenParaTablero('dist-1');
      expect(filas.map((f) => f.cashBoxId)).toEqual(['a', 'b']);
      // pidió las inactivas: no filtró por is_active
      expect(qb.andWhere).not.toHaveBeenCalledWith('c.isActive = true');
    });
  });
});
