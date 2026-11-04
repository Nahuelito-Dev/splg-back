import { BadRequestException, HttpException } from '@nestjs/common';
import { RoleType } from '../constants/role-type.enum';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';
import { faltaLaDistribuidora } from '../decorators/current-distributor.decorator';
import { assertSenaNoSuperaTotal } from '../../order/domain/deposit-cap';
import { autorizarAlta } from '../../registro/politica-de-registro';
import { traducirExcepcion } from '../validation/traducir-excepcion';
import { CODIGOS_DE_ERROR, conCodigo } from './con-codigo';

/**
 * Contrato con el panel y las apps publicadas: algunos textos del back los
 * reconoce el front (`/^Falta la distribuidora/`, «fuera del rango razonable»…).
 * El texto se conserva y se agrega un `code` en inglés, que es lo estable.
 */
function cuerpoDe(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (e) {
    return (e as HttpException).getResponse() as Record<string, unknown>;
  }
  throw new Error('no lanzó');
}

describe('conCodigo', () => {
  it('mantiene el shape {statusCode, message, error} y suma code', () => {
    const e = conCodigo(BadRequestException, 400, 'Texto', 'ALGO');
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toEqual({
      statusCode: 400,
      message: 'Texto',
      error: 'Bad Request',
      code: 'ALGO',
    });
  });

  it('el filtro traduce el error y deja pasar el code', () => {
    const e = traducirExcepcion(
      conCodigo(BadRequestException, 400, 'Texto', 'ALGO'),
    );
    expect(e.getResponse()).toEqual({
      statusCode: 400,
      message: 'Texto',
      error: 'Solicitud inválida',
      code: 'ALGO',
    });
  });
});

describe('textos que usa el front, con su code', () => {
  it('falta la distribuidora (panel: /^Falta la distribuidora/)', () => {
    const cuerpo = cuerpoDe(() => {
      throw faltaLaDistribuidora();
    });
    expect(cuerpo).toMatchObject({
      code: CODIGOS_DE_ERROR.MISSING_DISTRIBUTOR,
      message: expect.stringMatching(/^Falta la distribuidora/) as string,
    });
  });

  it('el alta sin distribuidora también lleva MISSING_DISTRIBUTOR', () => {
    const super_ = {
      tipo: 'usuario',
      usuario: {
        user_id: 'u',
        role: RoleType.SUPER_ADMIN,
      } as AuthenticatedUser,
    } as const;
    const cuerpo = cuerpoDe(() => autorizarAlta(super_, RoleType.DELIVERY));
    expect(cuerpo).toMatchObject({
      code: 'MISSING_DISTRIBUTOR',
      message: expect.stringMatching(/^Falta la distribuidora/) as string,
    });
  });

  it('seña mayor al total (panel: /no puede superar el total/)', () => {
    const cuerpo = cuerpoDe(() => assertSenaNoSuperaTotal(5000, 3000));
    expect(cuerpo).toMatchObject({
      code: 'DEPOSIT_EXCEEDS_TOTAL',
      message: expect.stringContaining('no puede superar el total') as string,
    });
  });
});
