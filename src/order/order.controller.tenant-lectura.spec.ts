import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RoleType } from '../common/constants/role-type.enum';
import { OrderController } from './order.controller';

type Opciones = { required?: boolean | 'staff' } | undefined;
interface Arg {
  index: number;
  data?: Opciones;
  factory: (opts: Opciones, ctx: ExecutionContext) => string | null;
}

const MENSAJE =
  'Falta la distribuidora: enviá el header X-Distributor (slug o id)';

/** El parámetro `@CurrentDistributor` de un método del controller, tal cual lo resuelve Nest. */
const tenantArg = (metodo: string): Arg => {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    OrderController,
    metodo,
  ) as Record<string, Arg>;
  const arg = Object.values(args).find(
    (a) => a.data?.required !== undefined || /Distributor/.test(a.factory.name),
  );
  if (!arg) throw new Error(`${metodo} no declara el tenant`);
  return arg;
};

const contexto = (role: RoleType, distributorId: string | null) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ distributorId, user: { role } }),
    }),
  }) as ExecutionContext;

/**
 * El detalle del pedido (con su enlace de pago) y la lista de reservas no se
 * leen sin distribuidora: el super admin sin `X-Distributor` recibiría datos
 * de todas.
 */
describe.each(['findOne', 'findReservations'])(
  'OrderController.%s',
  (metodo) => {
    it('el super admin sin X-Distributor es 400', () => {
      const { data, factory } = tenantArg(metodo);
      expect(() => factory(data, contexto(RoleType.SUPER_ADMIN, null))).toThrow(
        new BadRequestException(MENSAJE),
      );
    });

    it('el admin y el super admin con distribuidora pasan', () => {
      const { data, factory } = tenantArg(metodo);
      expect(factory(data, contexto(RoleType.ADMIN, 'd1'))).toBe('d1');
      expect(factory(data, contexto(RoleType.SUPER_ADMIN, 'd1'))).toBe('d1');
    });
  },
);
