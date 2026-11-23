import 'reflect-metadata';
import { RoleType } from '../common/constants/role-type.enum';
import { OrderController } from './order.controller';
import { DeliveryCodeV2Controller } from './delivery-code-v2.controller';
import { DeliveryCodeV3Controller } from './delivery-code-v3.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { VERSION_METADATA } from '@nestjs/common/constants';

/**
 * El código lo ve el cliente y lo escribe el chofer. La v1 y la v2 (congeladas)
 * se cierran por seguridad: el chofer no puede leer ni generar el código y el
 * cliente no puede confirmar. Se mira el decorador `@Auth` de cada ruta.
 */
const rolesDe = (clase: { prototype: object }, metodo: string): RoleType[] =>
  (Reflect.getMetadata(
    ROLES_KEY,
    (clase.prototype as Record<string, object>)[metodo],
  ) ?? Reflect.getMetadata(ROLES_KEY, clase)) as RoleType[];

describe('permisos del código de entrega', () => {
  it('v1: leer el código ya no es del chofer', () => {
    const roles = rolesDe(OrderController, 'getDeliveryCode');
    expect(roles).not.toContain(RoleType.DELIVERY);
    expect(roles).not.toContain(RoleType.CUSTOMER);
    expect(roles).toEqual(
      expect.arrayContaining([RoleType.ADMIN, RoleType.SUPER_ADMIN]),
    );
  });

  it('v1: confirmar la entrega ya no es del cliente', () => {
    const roles = rolesDe(OrderController, 'confirmDelivery');
    expect(roles).not.toContain(RoleType.CUSTOMER);
    expect(roles).not.toContain(RoleType.DELIVERY);
    expect(roles).toEqual(
      expect.arrayContaining([RoleType.ADMIN, RoleType.SUPER_ADMIN]),
    );
  });

  it('v2: generar un código nuevo ya no es del chofer (se lo vería en la respuesta)', () => {
    const roles = rolesDe(DeliveryCodeV2Controller, 'regenerate');
    expect(roles).not.toContain(RoleType.DELIVERY);
  });

  it('v3: el código lo ven y regeneran el cliente y el admin, nunca el chofer', () => {
    for (const metodo of ['getDeliveryCode', 'regenerate']) {
      const roles = rolesDe(DeliveryCodeV3Controller, metodo);
      expect([...roles].sort()).toEqual(
        [RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN].sort(),
      );
    }
  });

  it('v3: confirman el chofer y el admin, nunca el cliente', () => {
    const roles = rolesDe(DeliveryCodeV3Controller, 'confirm');
    expect([...roles].sort()).toEqual(
      [RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN].sort(),
    );
  });

  it('el controller de la v3 declara la versión 3', () => {
    expect(
      Reflect.getMetadata(VERSION_METADATA, DeliveryCodeV3Controller),
    ).toBe('3');
  });
});
