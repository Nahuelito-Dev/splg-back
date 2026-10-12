import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import { PurchaseOrderController } from './presentation/purchase-order.controller';
import { PurchaseReceiptController } from './presentation/purchase-receipt.controller';
import { SupplierController } from './presentation/supplier.controller';
import { CreateSupplierDto } from './dto/supplier.dto';
import { totalDe, TOTAL_MAXIMO } from './domain/purchase-rules';
import { MAX_COSTO, MAX_RENGLONES, MAX_UNIDADES } from './dto/purchase-limits';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

const idempotente = (clase: { prototype: object }, metodo: string): unknown =>
  Reflect.getMetadata(
    IDEMPOTENT_KEY,
    (clase.prototype as Record<string, object>)[metodo],
  );

describe('endpoints de compras', () => {
  it('los que mueven stock o numeran documentos aceptan Idempotency-Key', () => {
    expect(idempotente(PurchaseReceiptController, 'create')).toBe(true);
    expect(idempotente(PurchaseReceiptController, 'void')).toBe(true);
    expect(idempotente(PurchaseOrderController, 'create')).toBe(true);
    expect(idempotente(SupplierController, 'create')).toBe(true);
  });
});

describe('CreateSupplierDto', () => {
  const base = { businessName: 'Gas del Litoral', kind: 'filling_plant' };

  it('normaliza el CUIT con guiones', async () => {
    const dto = plainToInstance(CreateSupplierDto, {
      ...base,
      cuit: '30-71234567-1',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.cuit).toBe('30712345671');
  });

  it('rechaza un dígito verificador incorrecto', async () => {
    const errores = await validate(
      plainToInstance(CreateSupplierDto, { ...base, cuit: '30712345670' }),
    );
    expect(errores.map((e) => e.property)).toContain('cuit');
  });

  it('rechaza un plazo de pago negativo y un tipo desconocido', async () => {
    const errores = await validate(
      plainToInstance(CreateSupplierDto, {
        ...base,
        cuit: '30712345671',
        paymentTermsDays: -1,
        kind: 'x',
      }),
    );
    expect(errores.map((e) => e.property).sort()).toEqual([
      'kind',
      'paymentTermsDays',
    ]);
  });
});

describe('límites de los DTO', () => {
  it('el total máximo posible entra en numeric(12,2)', () => {
    const peor = Array.from({ length: MAX_RENGLONES }, () => ({
      quantity: MAX_UNIDADES,
      unitCost: MAX_COSTO,
    }));
    expect(totalDe(peor)).toBeLessThanOrEqual(TOTAL_MAXIMO);
  });
});
