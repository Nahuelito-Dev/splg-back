import { HttpException } from '@nestjs/common';
import * as E from './route-sheet.exceptions';

const cuerpo = (e: HttpException) =>
  e.getResponse() as { statusCode: number; message: string; code: string };

describe('errores de la hoja de ruta', () => {
  const casos: Array<[() => HttpException, number, string]> = [
    [E.planNoEncontrado, 404, 'ROUTE_PLAN_NOT_FOUND'],
    [E.fechaPasada, 409, 'ROUTE_PLAN_DATE_PAST'],
    [E.planCerrado, 409, 'ROUTE_PLAN_CLOSED'],
    [E.planOcupado, 409, 'ROUTE_PLAN_BUSY'],
    [E.planificacionApagada, 409, 'ROUTE_PLANNING_DISABLED'],
    [E.hojaNoEncontrada, 404, 'ROUTE_SHEET_NOT_FOUND'],
    [E.versionVieja, 409, 'ROUTE_SHEET_VERSION_CONFLICT'],
    [E.hojaNoEditable, 409, 'ROUTE_SHEET_NOT_EDITABLE'],
    [E.hojaNoCancelable, 409, 'ROUTE_SHEET_NOT_EDITABLE'],
    [E.hojaNoReabrible, 409, 'ROUTE_SHEET_NOT_EDITABLE'],
    [E.hojaOcupada, 409, 'ROUTE_SHEET_BUSY'],
    [E.hojaOtroDia, 409, 'ROUTE_SHEET_OTHER_DAY'],
    [E.mismaHoja, 400, 'ROUTE_SHEET_SAME_TARGET'],
    [E.secuenciaInvalida, 400, 'ROUTE_SHEET_SEQUENCE_INVALID'],
    [E.fijadasFueraDeLaHoja, 400, 'ROUTE_SHEET_SEQUENCE_INVALID'],
    [E.choferConOtraHoja, 409, 'ROUTE_SHEET_DRIVER_TAKEN'],
    [E.vehiculoConOtraHoja, 409, 'ROUTE_SHEET_CAR_TAKEN'],
    [E.paradaNoEncontrada, 404, 'ROUTE_STOP_NOT_FOUND'],
    [() => E.paradaNoFactible('x'), 409, 'ROUTE_STOP_NOT_FEASIBLE'],
    [E.pedidoNoEncontrado, 404, 'ORDER_NOT_FOUND'],
    [E.pedidoYaAgrupado, 409, 'ORDER_ALREADY_IN_ROUTE'],
    [() => E.pedidoNoPlanificable('x'), 409, 'ORDER_NOT_PLANNABLE'],
    [E.choferNoEncontrado, 404, 'DRIVER_NOT_FOUND'],
    [E.vehiculoNoEncontrado, 404, 'CAR_NOT_FOUND'],
    [E.depositoNoEncontrado, 404, 'WAREHOUSE_NOT_FOUND'],
  ];

  it.each(casos)(
    '%p responde con su estado y su code en inglés',
    (f, status, code) => {
      const e = f();
      expect(e.getStatus()).toBe(status);
      expect(cuerpo(e)).toMatchObject({ statusCode: status, code });
      expect(cuerpo(e).message).not.toMatch(/[A-Z_]{6,}/);
    },
  );

  it('el motivo de una parada o un pedido que no entra va en el mensaje', () => {
    expect(cuerpo(E.paradaNoFactible('la hoja está llena')).message).toBe(
      'El pedido no entra en la hoja: la hoja está llena',
    );
    expect(cuerpo(E.pedidoNoPlanificable('ya tiene chofer')).message).toBe(
      'El pedido no se puede planificar: ya tiene chofer',
    );
  });

  it('confirmar con violaciones las lista en el cuerpo y en el mensaje', () => {
    const v = [
      { code: 'driver_missing' as const, message: 'Falta el chofer' },
      {
        code: 'late_stops' as const,
        message: 'Hay paradas tarde',
        orderIds: ['o1'],
      },
    ];
    const e = E.noConfirmable(v);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({
      statusCode: 409,
      message:
        'No se puede confirmar la hoja: Falta el chofer; Hay paradas tarde',
      error: 'Conflict',
      code: 'ROUTE_SHEET_NOT_CONFIRMABLE',
      violations: v,
    });
  });
});
