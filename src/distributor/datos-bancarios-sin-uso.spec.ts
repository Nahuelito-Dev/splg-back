import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { crearValidationPipe } from '../common/validation/validation-pipe';
import { CashCollectionSettingsController } from '../cash/presentation/cash-collection-settings.controller';
import { UpdateCashCollectionSettingsDto } from '../cash/dto/cash-collection-settings.dto';
import { CashCollectionSettings } from '../cash/entities/cash-collection-settings.entity';
import { Distributor } from './entities/distributor.entity';
import { DistributorMapper } from './distributor.mapper';

const leer = (archivo: string): string =>
  readFileSync(join(__dirname, '../migrations', archivo), 'utf8');

describe('datos bancarios y caja de transferencias: se conservan sin uso', () => {
  it('la 170 no borra ninguna columna', () => {
    const sql = leer(
      '1795000000170-QuitarDatosBancariosYCajaDeTransferencias.ts',
    );
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(
      /DROP\s+CONSTRAINT\s+"FK_cash_collection_settings_transfer/i,
    );
  });

  it('la 182 repone las columnas de forma idempotente y no borra nada', () => {
    const sql = leer('1795000000182-ReponerDatosBancariosSinUso.ts');
    for (const columna of [
      'bank_cbu',
      'bank_alias',
      'bank_holder',
      'transfer_cash_box_id',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "${columna}"`);
    }
    expect(sql).toContain(
      'FK_cash_collection_settings_transfer_cash_box_distribuidora',
    );
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
    expect(sql).not.toMatch(/DROP\s+(COLUMN|TABLE)/i);
  });

  it('las entidades mapean las columnas y no las leen por omisión', () => {
    const columnas = getMetadataArgsStorage().columns;
    const de = (clase: abstract new () => object, propiedad: string) =>
      columnas.find((c) => c.target === clase && c.propertyName === propiedad);
    for (const p of ['bankCbu', 'bankAlias', 'bankHolder']) {
      expect(de(Distributor, p)?.options.select).toBe(false);
    }
    expect(
      de(CashCollectionSettings, 'transferCashBoxId')?.options.select,
    ).toBe(false);
  });

  it('la distribuidora no devuelve los datos bancarios aunque la entidad los traiga', () => {
    const d = Object.assign(new Distributor(), {
      distributorId: 'd1',
      name: 'Garrafas',
      bankCbu: '0170099220000067797370',
      bankAlias: 'garrafas.mp',
      bankHolder: 'Garrafas SA',
    });
    const json = JSON.stringify(DistributorMapper.toDto(d));
    expect(json).not.toMatch(/bank|cbu|alias|0170099220000067797370/i);
  });

  it('la configuración de cobros no devuelve la caja de transferencias', async () => {
    const controller = new CashCollectionSettingsController({
      obtener: jest.fn().mockResolvedValue({
        config: {
          mercadoPagoCashBoxId: 'wallet-1',
          transferCashBoxId: 'banco-1',
          updatedAt: new Date('2026-10-30T12:00:00Z'),
        },
        nombres: new Map([['wallet-1', 'Mercado Pago']]),
      }),
    } as never);
    const r = await controller.ver('dist-1');
    expect(Object.keys(r).sort()).toEqual([
      'mercadoPagoCashBoxId',
      'mercadoPagoCashBoxName',
      'updatedAt',
    ]);
  });

  it('el DTO de configuración rechaza la caja de transferencias', async () => {
    const pipe = crearValidationPipe();
    await expect(
      pipe.transform(
        { transferCashBoxId: '8a1c0b9e-0c4e-4c52-9d4e-0a1f2b3c4d5e' },
        { type: 'body', metatype: UpdateCashCollectionSettingsDto },
      ),
    ).rejects.toBeDefined();
    const dto = plainToInstance(UpdateCashCollectionSettingsDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });
});
