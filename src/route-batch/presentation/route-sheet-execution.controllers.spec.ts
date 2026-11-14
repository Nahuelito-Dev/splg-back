import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { RoleType } from '../../common/constants/role-type.enum';
import { RouteSheetCloseService } from '../application/route-sheet-close.service';
import { RouteSheetEditingService } from '../application/route-sheet-editing.service';
import { RouteSheetExecutionQueryService } from '../application/route-sheet-execution-query.service';
import { RouteSheetInProgressEditingService } from '../application/route-sheet-in-progress-editing.service';
import { RouteSheetLifecycleService } from '../application/route-sheet-lifecycle.service';
import { RouteSheetPdfService } from '../application/route-sheet-pdf.service';
import { RouteSheetQueryService } from '../application/route-sheet-query.service';
import { RouteSheetStartService } from '../application/route-sheet-start.service';
import {
  FailedDeliveryReason,
  RouteSheetStopsService,
} from '../application/route-sheet-stops.service';
import { DIST, hojaDto } from '../application/route-sheet.fixtures';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { DriverRouteSheetsController } from './driver-route-sheets.controller';
import { OrderEtaController } from './order-eta.controller';
import { RouteSheetsController } from './route-sheets.controller';

const ID = 'hoja-1';
const PEDIDO = 'o1';
const USUARIO = 'u1';

function armar() {
  const query = {
    actualDelChofer: jest.fn().mockResolvedValue({ id: ID }),
    delChofer: jest.fn().mockResolvedValue({ id: ID }),
    seguimiento: jest.fn().mockResolvedValue({ id: ID }),
    etaDelPedido: jest.fn().mockResolvedValue({ orderId: PEDIDO }),
  };
  const start = { iniciar: jest.fn().mockResolvedValue({ sheetId: ID }) };
  const stops = {
    enCamino: jest.fn().mockResolvedValue({ sheetId: ID }),
    llegue: jest.fn().mockResolvedValue({ message: 'ok' }),
    noEntregada: jest.fn().mockResolvedValue({ sheetId: ID }),
  };
  const close = { cerrar: jest.fn().mockResolvedValue({ sheetId: ID }) };
  const enCurso = {
    agregarEnCurso: jest.fn().mockResolvedValue(undefined),
    quitarEnCurso: jest.fn().mockResolvedValue(undefined),
  };
  const editing = {
    agregar: jest.fn().mockResolvedValue(undefined),
    quitar: jest.fn().mockResolvedValue(undefined),
  };
  const hojas = {
    detalle: jest.fn().mockResolvedValue(hojaDto()),
    detalleSinMapear: jest
      .fn()
      .mockResolvedValue({ status: RouteBatchStatus.ASSIGNED }),
  };
  const chofer = new DriverRouteSheetsController(
    query as unknown as RouteSheetExecutionQueryService,
    start as unknown as RouteSheetStartService,
    stops as unknown as RouteSheetStopsService,
    close as unknown as RouteSheetCloseService,
  );
  const panel = new RouteSheetsController(
    editing as unknown as RouteSheetEditingService,
    {} as unknown as RouteSheetLifecycleService,
    hojas as unknown as RouteSheetQueryService,
    {} as unknown as RouteSheetPdfService,
    start as unknown as RouteSheetStartService,
    stops as unknown as RouteSheetStopsService,
    close as unknown as RouteSheetCloseService,
    enCurso as unknown as RouteSheetInProgressEditingService,
    query as unknown as RouteSheetExecutionQueryService,
  );
  const cliente = new OrderEtaController(
    query as unknown as RouteSheetExecutionQueryService,
  );
  return {
    chofer,
    panel,
    cliente,
    query,
    start,
    stops,
    close,
    enCurso,
    editing,
    hojas,
  };
}

const respuesta = () => {
  const res = { status: jest.fn() };
  return { res, r: res as unknown as Response };
};

describe('controladores de la hoja en curso', () => {
  it('roles: el chofer sólo en su controlador; el inicio del panel también acepta al chofer', () => {
    const reflector = new Reflector();
    expect(reflector.get('roles', DriverRouteSheetsController)).toEqual([
      RoleType.DELIVERY,
    ]);
    expect(reflector.get('roles', OrderEtaController)).toEqual([
      RoleType.CUSTOMER,
    ]);
    const start = Object.getOwnPropertyDescriptor(
      RouteSheetsController.prototype,
      'iniciar',
    )?.value as () => void;
    expect(reflector.get('roles', start)).toEqual([
      RoleType.DELIVERY,
      RoleType.ADMIN,
      RoleType.SUPER_ADMIN,
    ]);
    const seguimiento = Object.getOwnPropertyDescriptor(
      RouteSheetsController.prototype,
      'seguimiento',
    )?.value as () => void;
    // Hereda el de la clase: admin y super admin (lectura en modo soporte).
    expect(reflector.get('roles', seguimiento)).toBeUndefined();
  });

  describe('chofer', () => {
    it('hoja actual: 200 con la hoja, 204 sin hoja', async () => {
      const t = armar();
      const a = respuesta();
      expect(await t.chofer.actual(USUARIO, DIST, a.r)).toEqual({ id: ID });
      expect(a.res.status).not.toHaveBeenCalled();
      t.query.actualDelChofer.mockResolvedValue(null);
      const b = respuesta();
      expect(await t.chofer.actual(USUARIO, DIST, b.r)).toBeUndefined();
      expect(b.res.status).toHaveBeenCalledWith(204);
    });

    it('delega con su identidad (nunca la del cuerpo)', async () => {
      const t = armar();
      await t.chofer.detalle(ID, USUARIO, DIST);
      expect(t.query.delChofer).toHaveBeenCalledWith(DIST, USUARIO, ID);
      await t.chofer.iniciar(ID, { acknowledgeShortages: true }, USUARIO, DIST);
      expect(t.start.iniciar).toHaveBeenCalledWith(
        DIST,
        ID,
        { userId: USUARIO, esChofer: true },
        true,
      );
      await t.chofer.iniciar(ID, {}, USUARIO, DIST);
      expect(t.start.iniciar).toHaveBeenLastCalledWith(
        DIST,
        ID,
        { userId: USUARIO, esChofer: true },
        false,
      );
      await t.chofer.enCamino(ID, PEDIDO, USUARIO, DIST);
      expect(t.stops.enCamino).toHaveBeenCalledWith(DIST, ID, PEDIDO, USUARIO);
      const pos = { latitude: -27.4, longitude: -55.9 };
      await t.chofer.llegue(ID, PEDIDO, pos, USUARIO, DIST);
      expect(t.stops.llegue).toHaveBeenCalledWith(
        DIST,
        ID,
        PEDIDO,
        USUARIO,
        pos,
      );
      const motivo = { reason: FailedDeliveryReason.REJECTED };
      await t.chofer.noEntregada(ID, PEDIDO, motivo, USUARIO, DIST);
      expect(t.stops.noEntregada).toHaveBeenCalledWith(
        DIST,
        ID,
        PEDIDO,
        { userId: USUARIO, esChofer: true },
        motivo,
      );
      await t.chofer.cerrar(ID, { reason: 'Se rompió' }, USUARIO, DIST);
      expect(t.close.cerrar).toHaveBeenCalledWith(
        DIST,
        ID,
        { userId: USUARIO, esChofer: true },
        'Se rompió',
      );
    });
  });

  describe('panel', () => {
    it('iniciar: el rol decide si es el chofer o un admin en su nombre', async () => {
      const t = armar();
      await t.panel.iniciar(
        ID,
        {},
        { user_id: USUARIO, role: RoleType.ADMIN } as never,
        DIST,
      );
      expect(t.start.iniciar).toHaveBeenCalledWith(
        DIST,
        ID,
        { userId: USUARIO, esChofer: false },
        false,
      );
      await t.panel.iniciar(
        ID,
        { acknowledgeShortages: true },
        { user_id: 'u-ch', role: RoleType.DELIVERY } as never,
        DIST,
      );
      expect(t.start.iniciar).toHaveBeenLastCalledWith(
        DIST,
        ID,
        { userId: 'u-ch', esChofer: true },
        true,
      );
    });

    it('seguimiento, no entregada y cierre como admin', async () => {
      const t = armar();
      expect(await t.panel.seguimiento(ID, DIST)).toEqual({ id: ID });
      await t.panel.noEntregada(
        ID,
        PEDIDO,
        { reason: FailedDeliveryReason.OTHER, note: 'portón' },
        USUARIO,
        DIST,
      );
      expect(t.stops.noEntregada).toHaveBeenCalledWith(
        DIST,
        ID,
        PEDIDO,
        { userId: USUARIO, esChofer: false },
        { reason: FailedDeliveryReason.OTHER, note: 'portón' },
      );
      await t.panel.cerrar(ID, { reason: 'Fin del día' }, USUARIO, DIST);
      expect(t.close.cerrar).toHaveBeenCalledWith(
        DIST,
        ID,
        { userId: USUARIO, esChofer: false },
        'Fin del día',
      );
    });

    it('agregar y quitar con la hoja en curso van a la edición en curso; en borrador, a la de siempre', async () => {
      const t = armar();
      await t.panel.agregar(ID, { version: 3, orderId: PEDIDO }, DIST, USUARIO);
      expect(t.enCurso.agregarEnCurso).toHaveBeenCalledWith(
        DIST,
        ID,
        { version: 3, orderId: PEDIDO },
        USUARIO,
      );
      await t.panel.quitar(ID, PEDIDO, { version: 3 }, DIST, USUARIO);
      expect(t.enCurso.quitarEnCurso).toHaveBeenCalledWith(
        DIST,
        ID,
        PEDIDO,
        3,
        USUARIO,
      );
      expect(t.editing.agregar).not.toHaveBeenCalled();
      expect(t.editing.quitar).not.toHaveBeenCalled();
      t.hojas.detalleSinMapear.mockResolvedValue({
        status: RouteBatchStatus.DRAFT,
      });
      await t.panel.agregar(ID, { version: 3, orderId: PEDIDO }, DIST, USUARIO);
      await t.panel.quitar(ID, PEDIDO, { version: 3 }, DIST, USUARIO);
      expect(t.editing.agregar).toHaveBeenCalled();
      expect(t.editing.quitar).toHaveBeenCalled();
    });
  });

  describe('cliente', () => {
    it('200 con la franja, 204 si el pedido no va en una hoja', async () => {
      const t = armar();
      const a = respuesta();
      expect(await t.cliente.eta(PEDIDO, USUARIO, a.r)).toEqual({
        orderId: PEDIDO,
      });
      expect(t.query.etaDelPedido).toHaveBeenCalledWith(USUARIO, PEDIDO);
      t.query.etaDelPedido.mockResolvedValue(null);
      const b = respuesta();
      expect(await t.cliente.eta(PEDIDO, USUARIO, b.r)).toBeUndefined();
      expect(b.res.status).toHaveBeenCalledWith(204);
    });
  });
});
