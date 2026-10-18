import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CashBoxController } from '../cash/presentation/cash-box.controller';
import { CashCategoryController } from '../cash/presentation/cash-category.controller';
import { CashMovementController } from '../cash/presentation/cash-movement.controller';
import { CashSessionController } from '../cash/presentation/cash-session.controller';
import {
  CreateCashMovementDto,
  QueryCashMovementDto,
  TransferCashDto,
} from '../cash/dto/cash-movement.dto';
import { CreateCashBoxDto } from '../cash/dto/cash-box.dto';
import { CommissionRuleController } from '../commission/presentation/commission-rule.controller';
import { DriverLiquidationController } from '../commission/presentation/driver-liquidation.controller';
import {
  CreateCommissionRuleDto,
  UpdateCommissionRuleDto,
} from '../commission/dto/commission.dto';
import { CreateDriverLiquidationDto } from '../commission/dto/driver-liquidation.dto';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import {
  CreateCustomerAccountDto,
  RegisterAdjustmentDto,
  RegisterPaymentDto,
  UpdateCustomerAccountDto,
} from '../customer-account/dto/customer-account.dto';
import { CustomerAccountController } from '../customer-account/presentation/customer-account.controller';
import { DriverSettlementController } from '../driver-settlement/presentation/driver-settlement.controller';
import { CommissionController } from '../commission/presentation/commission.controller';
import {
  ApproveDriverSettlementDto,
  SubmitDriverSettlementDto,
} from '../driver-settlement/dto/driver-settlement.dto';
import { FinanceController } from './presentation/finance.controller';

type Clase = { name: string; prototype: object };

const handler = (clase: Clase, metodo: string): object =>
  (clase.prototype as Record<string, object>)[metodo];

const idempotente = (clase: Clase, metodo: string): unknown =>
  Reflect.getMetadata(IDEMPOTENT_KEY, handler(clase, metodo));

const roles = (clase: Clase, metodo: string): RoleType[] | undefined =>
  (Reflect.getMetadata(ROLES_KEY, handler(clase, metodo)) as
    | RoleType[]
    | undefined) ??
  (Reflect.getMetadata(ROLES_KEY, clase) as RoleType[] | undefined);

interface ArgCustom {
  data?: { required?: boolean | 'staff' };
}

const exigeDistribuidora = (clase: Clase, metodo: string): boolean => {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    clase,
    metodo,
  ) as Record<string, ArgCustom>;
  return Object.values(args).some((a) => Boolean(a.data?.required));
};

/** Escrituras que mueven plata o numeran documentos. */
const ESCRITURAS: Array<[Clase, string[]]> = [
  [CashBoxController, ['create', 'update', 'open']],
  [CashSessionController, ['close']],
  [
    CashMovementController,
    ['create', 'transfer', 'reverse', 'reverseTransfer'],
  ],
  [CashCategoryController, ['create', 'update']],
  [DriverSettlementController, ['open', 'submit', 'approve', 'reopen']],
  [
    CustomerAccountController,
    ['create', 'update', 'registerPayment', 'registerAdjustment'],
  ],
  [CommissionRuleController, ['create', 'update']],
  [DriverLiquidationController, ['create', 'approve', 'pay', 'unpay', 'void']],
];

const todos = ESCRITURAS.flatMap(([clase, metodos]) =>
  metodos.map((m) => [`${clase.name}.${m}`, clase, m] as const),
);

describe('endpoints de finanzas', () => {
  it.each(todos)('%s es @Idempotent()', (_n, clase, metodo) => {
    expect(idempotente(clase, metodo)).toBe(true);
  });

  it.each(todos)('%s exige distribuidora en contexto', (_n, clase, metodo) => {
    expect(exigeDistribuidora(clase, metodo)).toBe(true);
  });

  it('el tablero y las consultas también exigen distribuidora', () => {
    expect(exigeDistribuidora(FinanceController, 'dashboard')).toBe(true);
    expect(exigeDistribuidora(CommissionController, 'findAll')).toBe(true);
    expect(exigeDistribuidora(CommissionController, 'mine')).toBe(true);
    expect(exigeDistribuidora(CustomerAccountController, 'aging')).toBe(true);
  });

  it('administración por defecto; el chofer sólo en lo que le toca', () => {
    const soloAdmin = [RoleType.ADMIN, RoleType.SUPER_ADMIN];
    expect(roles(CashMovementController, 'create')).toEqual(soloAdmin);
    expect(roles(DriverLiquidationController, 'pay')).toEqual(soloAdmin);
    expect(roles(DriverLiquidationController, 'unpay')).toEqual(soloAdmin);
    expect(roles(CashMovementController, 'reverseTransfer')).toEqual(soloAdmin);
    expect(roles(CommissionRuleController, 'create')).toEqual(soloAdmin);
    expect(roles(FinanceController, 'dashboard')).toEqual(soloAdmin);
    expect(roles(DriverSettlementController, 'approve')).toEqual(soloAdmin);
    expect(roles(CommissionController, 'mine')).toEqual([RoleType.DELIVERY]);
    expect(roles(DriverSettlementController, 'mine')).toEqual([
      RoleType.DELIVERY,
    ]);
    expect(roles(DriverSettlementController, 'submit')).toEqual([
      ...soloAdmin,
      RoleType.DELIVERY,
    ]);
    expect(roles(CustomerAccountController, 'registerPayment')).toEqual([
      ...soloAdmin,
      RoleType.DELIVERY,
    ]);
    // El ajuste de la cuenta corriente no lo hace el chofer.
    expect(roles(CustomerAccountController, 'registerAdjustment')).toEqual(
      soloAdmin,
    );
  });
});

const errores = async (
  clase: new () => object,
  plano: object,
): Promise<string[]> =>
  (await validate(plainToInstance(clase, plano))).map((e) => e.property).sort();

describe('DTOs de finanzas', () => {
  describe('importes', () => {
    const base = {
      cashBoxId: '5b0c3f6e-4f0a-4a8e-9a53-0c3a2b1d9e11',
      direction: 'in',
      categoryId: '8d1c2f4a-0b7e-4c52-8a1d-2b3c4d5e6f70',
      description: 'Cobro',
    };

    it.each([0, -1, 1.234, 'abc', 1e12])(
      'rechaza el importe %p',
      async (amount) => {
        expect(
          await errores(CreateCashMovementDto, { ...base, amount }),
        ).toContain('amount');
      },
    );

    it.each([0.01, 100, 2500.5])('acepta el importe %p', async (amount) => {
      expect(await errores(CreateCashMovementDto, { ...base, amount })).toEqual(
        [],
      );
    });

    it('acepta el importe como texto numérico de una consulta', async () => {
      expect(
        await errores(CreateCashMovementDto, { ...base, amount: '12.50' }),
      ).toEqual([]);
    });

    it('exige un sentido válido y un motivo no vacío', async () => {
      expect(
        await errores(CreateCashMovementDto, {
          ...base,
          amount: 5,
          direction: 'x',
          description: '  ',
        }),
      ).toEqual(['description', 'direction']);
    });

    it('la transferencia necesita las dos cajas y un monto positivo', async () => {
      expect(await errores(TransferCashDto, { amount: 0 })).toEqual([
        'amount',
        'fromCashBoxId',
        'toCashBoxId',
      ]);
    });
  });

  it('una caja nueva exige nombre y un tipo conocido', async () => {
    expect(
      await errores(CreateCashBoxDto, { name: '', kind: 'cheque' }),
    ).toEqual(['kind', 'name']);
    expect(
      await errores(CreateCashBoxDto, { name: 'Caja', kind: 'wallet' }),
    ).toEqual([]);
  });

  it('el período del libro exige fechas reales', async () => {
    expect(await errores(QueryCashMovementDto, { from: '2026-02-30' })).toEqual(
      ['from'],
    );
    expect(
      await errores(QueryCashMovementDto, {
        from: '2026-02-28',
        to: '2026-03-01',
      }),
    ).toEqual([]);
  });

  describe('cuenta corriente', () => {
    const base = {
      customerUserId: '5b0c3f6e-4f0a-4a8e-9a53-0c3a2b1d9e11',
      businessName: 'Panadería',
      taxCondition: 'registered',
      creditLimit: 1000,
      paymentTermsDays: 30,
    };

    it('normaliza el CUIT con guiones y rechaza el dígito verificador incorrecto', async () => {
      const ok = plainToInstance(CreateCustomerAccountDto, {
        ...base,
        taxId: '30-71234567-1',
      });
      expect(await validate(ok)).toHaveLength(0);
      expect(ok.taxId).toBe('30712345671');
      expect(
        await errores(CreateCustomerAccountDto, {
          ...base,
          taxId: '30712345670',
        }),
      ).toEqual(['taxId']);
    });

    it('rechaza límite negativo, plazo cero o fraccionario y condición fiscal desconocida', async () => {
      expect(
        await errores(CreateCustomerAccountDto, {
          ...base,
          creditLimit: -1,
          paymentTermsDays: 1.5,
          taxCondition: 'otra',
        }),
      ).toEqual(['creditLimit', 'paymentTermsDays', 'taxCondition']);
      expect(
        await errores(CreateCustomerAccountDto, {
          ...base,
          paymentTermsDays: 0,
        }),
      ).toEqual(['paymentTermsDays']);
    });

    it('un cambio parcial no exige nada, pero valida lo que viene', async () => {
      expect(await errores(UpdateCustomerAccountDto, {})).toEqual([]);
      expect(
        await errores(UpdateCustomerAccountDto, {
          creditLimit: -5,
          status: 'x',
        }),
      ).toEqual(['creditLimit', 'status']);
    });

    it('el pago necesita un medio conocido; el ajuste, un motivo', async () => {
      expect(
        await errores(RegisterPaymentDto, { amount: 5, method: 'trueque' }),
      ).toEqual(['method']);
      expect(
        await errores(RegisterAdjustmentDto, {
          kind: 'debit',
          amount: 5,
          reason: ' ',
        }),
      ).toEqual(['reason']);
      expect(
        await errores(RegisterAdjustmentDto, {
          kind: 'otro',
          amount: 5,
          reason: 'x',
        }),
      ).toEqual(['kind']);
    });
  });

  describe('comisiones', () => {
    const base = { basis: 'per_unit', value: 150, validFrom: '2026-11-01' };

    it('acepta hasta cuatro decimales y rechaza más, negativos y bases desconocidas', async () => {
      expect(
        await errores(CreateCommissionRuleDto, { ...base, value: 2.5555 }),
      ).toEqual([]);
      expect(
        await errores(CreateCommissionRuleDto, { ...base, value: 2.55555 }),
      ).toEqual(['value']);
      expect(
        await errores(CreateCommissionRuleDto, { ...base, value: -1 }),
      ).toEqual(['value']);
      expect(
        await errores(CreateCommissionRuleDto, { ...base, basis: 'por_kilo' }),
      ).toEqual(['basis']);
    });

    it('la vigencia es de fechas reales; validTo vacío deja la regla abierta', async () => {
      expect(
        await errores(CreateCommissionRuleDto, {
          ...base,
          validFrom: '2026-02-30',
        }),
      ).toEqual(['validFrom']);
      const dto = plainToInstance(UpdateCommissionRuleDto, { validTo: '' });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.validTo).toBeNull();
    });

    it('la liquidación necesita el chofer y un período real', async () => {
      expect(await errores(CreateDriverLiquidationDto, {})).toEqual([
        'employeeId',
        'periodFrom',
        'periodTo',
      ]);
    });
  });

  describe('rendición', () => {
    it('el efectivo declarado puede ser cero pero no negativo; los gastos, mayores a cero', async () => {
      expect(
        await errores(SubmitDriverSettlementDto, { declaredCash: 0 }),
      ).toEqual([]);
      expect(
        await errores(SubmitDriverSettlementDto, { declaredCash: -1 }),
      ).toEqual(['declaredCash']);
      expect(
        await errores(SubmitDriverSettlementDto, {
          declaredCash: 0,
          expenses: [{ categoryId: 'no-uuid', amount: 0 }],
        }),
      ).toEqual(['expenses']);
    });

    it('aprobar exige la caja y una resolución conocida', async () => {
      expect(
        await errores(ApproveDriverSettlementDto, {
          differenceResolution: 'x',
        }),
      ).toEqual(['cashBoxId', 'differenceResolution']);
    });
  });
});
