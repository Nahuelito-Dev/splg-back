import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RoleType } from '../constants/role-type.enum';
import { CurrentDistributor } from './current-distributor.decorator';

type Opciones = { required?: boolean | 'staff' } | undefined;
type Fabrica = (opts: Opciones, ctx: ExecutionContext) => string | null;

/** La función que Nest ejecuta para resolver el parámetro. */
function fabrica(): Fabrica {
  class Probe {
    metodo(@CurrentDistributor() _d: unknown) {
      return _d;
    }
  }
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    Probe,
    'metodo',
  ) as Record<string, { factory: Fabrica }>;
  return Object.values(args)[0].factory;
}

const contexto = (request: object): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

describe('CurrentDistributor', () => {
  const resolver = fabrica();
  const DIST = 'd1';
  const MENSAJE =
    'Falta la distribuidora: enviá el header X-Distributor (slug o id)';

  it('devuelve el tenant de la request', () => {
    expect(resolver(undefined, contexto({ distributorId: DIST }))).toBe(DIST);
  });

  it('sin tenant devuelve null si no es obligatorio', () => {
    expect(resolver(undefined, contexto({ distributorId: null }))).toBeNull();
  });

  it('required: true sin tenant es 400', () => {
    expect(() =>
      resolver({ required: true }, contexto({ distributorId: null })),
    ).toThrow(new BadRequestException(MENSAJE));
  });

  describe("required: 'staff'", () => {
    const req = (role: RoleType, distributorId: string | null) =>
      contexto({ distributorId, user: { role } });

    it('el super admin sin distribuidora es 400', () => {
      expect(() =>
        resolver({ required: 'staff' }, req(RoleType.SUPER_ADMIN, null)),
      ).toThrow(new BadRequestException(MENSAJE));
    });

    it('el super admin con X-Distributor pasa', () => {
      expect(
        resolver({ required: 'staff' }, req(RoleType.SUPER_ADMIN, DIST)),
      ).toBe(DIST);
    });

    it('el chofer y el admin pasan con la de su perfil', () => {
      expect(
        resolver({ required: 'staff' }, req(RoleType.DELIVERY, DIST)),
      ).toBe(DIST);
      expect(resolver({ required: 'staff' }, req(RoleType.ADMIN, DIST))).toBe(
        DIST,
      );
    });

    it('el cliente sin distribuidora pasa (sólo toca lo suyo)', () => {
      expect(
        resolver({ required: 'staff' }, req(RoleType.CUSTOMER, null)),
      ).toBeNull();
    });
  });
});
