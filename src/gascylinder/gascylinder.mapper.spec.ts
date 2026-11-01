import { GasCylinder } from './entities/gascylinder.entity';
import { GasCylinderMapper } from './gascylinder.mapper';

const garrafa = (over: Partial<GasCylinder> = {}): GasCylinder =>
  ({
    gasCylinderId: 'g1',
    distributorId: 'd1',
    type: 'Garrafa 10kg',
    weight: 10,
    price: 14900,
    stock: 5,
    description: null,
    isActive: true,
    photoSignedUrl: null,
    promotions: [
      { quantity: 4, discountPercentage: 12 },
      { quantity: 2, discountPercentage: 5 },
    ],
    ...over,
  }) as unknown as GasCylinder;

describe('GasCylinderMapper · precio de cada promoción', () => {
  it('cada promoción trae el precio unitario que cobra el pedido, de menor a mayor cantidad', () => {
    expect(GasCylinderMapper.toDto(garrafa()).promotions).toEqual([
      { quantity: 2, discountPercentage: 5, unitPrice: 14155 },
      { quantity: 4, discountPercentage: 12, unitPrice: 13112 },
    ]);
  });

  it('redondea a centavos como el pedido (mitad hacia arriba)', () => {
    const [promo] = GasCylinderMapper.toDto(
      garrafa({
        price: 999.99,
        promotions: [{ quantity: 3, discountPercentage: 7.5 }],
      } as Partial<GasCylinder>),
    ).promotions!;
    expect(promo.unitPrice).toBe(924.99);
  });

  it('el catálogo público trae el mismo precio', () => {
    expect(GasCylinderMapper.toPublicDto(garrafa()).promotions[0]).toEqual({
      quantity: 2,
      discountPercentage: 5,
      unitPrice: 14155,
    });
  });

  it('sin promociones sale null en el catálogo y lista vacía en el público', () => {
    expect(
      GasCylinderMapper.toDto(garrafa({ promotions: [] })).promotions,
    ).toBeNull();
    expect(
      GasCylinderMapper.toPublicDto(garrafa({ promotions: [] })).promotions,
    ).toEqual([]);
  });
});
