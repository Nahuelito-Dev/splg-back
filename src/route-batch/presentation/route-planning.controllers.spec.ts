import { Reflector } from '@nestjs/core';
import { StreamableFile } from '@nestjs/common';
import { RoleType } from '../../common/constants/role-type.enum';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RoutePlanProposalService } from '../application/route-plan-proposal.service';
import { RoutePlanService } from '../application/route-plan.service';
import { RouteSheetEditingService } from '../application/route-sheet-editing.service';
import { RouteSheetLifecycleService } from '../application/route-sheet-lifecycle.service';
import { RouteSheetPdfService } from '../application/route-sheet-pdf.service';
import { RouteSheetQueryService } from '../application/route-sheet-query.service';
import { DIA, DIST, hojaDto } from '../application/route-sheet.fixtures';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import {
  RoutePlanningSettingsController,
  RoutePlansController,
} from './route-plans.controller';
import { RouteSheetsController } from './route-sheets.controller';

const ID = 'hoja-1';
const OTRA = 'hoja-2';
const PEDIDO = 'o1';
const USUARIO = 'u1';

describe('controladores de la hoja de ruta', () => {
  let plans: Record<string, jest.Mock>;
  let proposal: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;
  let editing: Record<string, jest.Mock>;
  let lifecycle: Record<string, jest.Mock>;
  let pdfs: Record<string, jest.Mock>;
  let processConfig: Record<string, jest.Mock>;
  let planes: RoutePlansController;
  let hojas: RouteSheetsController;
  let ajustes: RoutePlanningSettingsController;

  beforeEach(() => {
    plans = {
      abrir: jest.fn().mockResolvedValue({}),
      cerrar: jest.fn().mockResolvedValue({}),
      confirmarTodas: jest
        .fn()
        .mockResolvedValue({ confirmed: [ID], failed: [] }),
    };
    proposal = { proponer: jest.fn().mockResolvedValue({ dryRun: true }) };
    query = {
      dia: jest.fn().mockResolvedValue({ plan: { date: DIA } }),
      tardios: jest.fn().mockResolvedValue([]),
      detalle: jest.fn((_d: string, id: string) =>
        Promise.resolve(hojaDto({ id })),
      ),
      listar: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      cargaSugerida: jest.fn().mockResolvedValue({ sheetId: ID, items: [] }),
    };
    editing = {
      crear: jest.fn().mockResolvedValue(ID),
      editar: jest.fn().mockResolvedValue(undefined),
      agregar: jest.fn().mockResolvedValue(undefined),
      quitar: jest.fn().mockResolvedValue(undefined),
      mover: jest.fn().mockResolvedValue(undefined),
      ordenar: jest.fn().mockResolvedValue(undefined),
      optimizar: jest.fn().mockResolvedValue({
        before: { durationMin: 9 },
        after: { durationMin: 5 },
      }),
    };
    lifecycle = {
      confirmar: jest.fn().mockResolvedValue(undefined),
      reabrir: jest.fn().mockResolvedValue(undefined),
      cancelar: jest.fn().mockResolvedValue(undefined),
    };
    pdfs = {
      pdf: jest.fn().mockResolvedValue({
        contenido: Buffer.from('%PDF-1'),
        nombre: 'hoja de ruta.pdf',
      }),
    };
    processConfig = {
      vigentes: jest.fn().mockResolvedValue({ params: {} }),
      obtener: jest.fn().mockResolvedValue({ enabled: 0, cutoffHour: 18 }),
      guardar: jest.fn().mockResolvedValue({ params: {} }),
    };
    planes = new RoutePlansController(
      plans as unknown as RoutePlanService,
      proposal as unknown as RoutePlanProposalService,
      query as unknown as RouteSheetQueryService,
    );
    hojas = new RouteSheetsController(
      editing as unknown as RouteSheetEditingService,
      lifecycle as unknown as RouteSheetLifecycleService,
      query as unknown as RouteSheetQueryService,
      pdfs as unknown as RouteSheetPdfService,
    );
    ajustes = new RoutePlanningSettingsController(
      processConfig as unknown as ProcessConfigService,
    );
  });

  it('el día: ver, abrir, proponer, cerrar, confirmar todas y tardíos, siempre con la distribuidora del contexto', async () => {
    const p = { date: DIA };
    await planes.dia(p, DIST);
    expect(query.dia).toHaveBeenLastCalledWith(DIST, DIA);
    await planes.abrir(p, DIST);
    expect(plans.abrir).toHaveBeenCalledWith(DIST, DIA);
    await planes.proponer(p, {}, DIST);
    expect(proposal.proponer).toHaveBeenLastCalledWith(DIST, DIA, false);
    await planes.proponer(p, { dryRun: true }, DIST);
    expect(proposal.proponer).toHaveBeenLastCalledWith(DIST, DIA, true);
    await planes.cerrar(p, DIST, USUARIO);
    expect(plans.cerrar).toHaveBeenCalledWith(DIST, DIA, USUARIO);
    expect(query.dia).toHaveBeenCalledTimes(3);
    expect(await planes.confirmarTodas(p, DIST, USUARIO)).toEqual({
      confirmed: [ID],
      failed: [],
    });
    expect(plans.confirmarTodas).toHaveBeenCalledWith(DIST, DIA, USUARIO);
    await planes.tardios(p, DIST);
    expect(query.tardios).toHaveBeenCalledWith(DIST, DIA);
  });

  it('parámetros: se leen del proceso route_planning y el PATCH cambia sólo los que vienen', async () => {
    await ajustes.settings(DIST);
    expect(processConfig.vigentes).toHaveBeenCalledWith(
      DIST,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    await ajustes.patch(
      { enabled: 1, trafficFactor: undefined },
      DIST,
      USUARIO,
    );
    expect(processConfig.guardar).toHaveBeenCalledWith(
      DIST,
      ConfigurableProcess.ROUTE_PLANNING,
      { enabled: 1, cutoffHour: 18 },
      USUARIO,
    );
  });

  it('cada edición llama al servicio y devuelve la hoja como quedó', async () => {
    expect((await hojas.crear({ planDate: DIA }, DIST)).id).toBe(ID);
    expect(editing.crear).toHaveBeenCalledWith(DIST, { planDate: DIA });
    await hojas.listar({ date: DIA, status: RouteBatchStatus.DRAFT }, DIST);
    expect(query.listar).toHaveBeenCalledWith(DIST, {
      date: DIA,
      status: RouteBatchStatus.DRAFT,
      deliveryId: undefined,
      limit: 10,
      offset: 0,
    });
    await hojas.listar({ limit: 5, offset: 10, deliveryId: 'd1' }, DIST);
    expect(query.listar).toHaveBeenLastCalledWith(
      DIST,
      expect.objectContaining({ limit: 5, offset: 10, deliveryId: 'd1' }),
    );
    expect((await hojas.detalle(ID, DIST)).id).toBe(ID);

    await hojas.editar(ID, { version: 1, carId: 'c1' }, DIST);
    expect(editing.editar).toHaveBeenCalledWith(DIST, ID, {
      version: 1,
      carId: 'c1',
    });
    await hojas.agregar(ID, { version: 1, orderId: PEDIDO }, DIST);
    expect(editing.agregar).toHaveBeenCalledWith(DIST, ID, {
      version: 1,
      orderId: PEDIDO,
    });
    await hojas.quitar(ID, PEDIDO, { version: 2 }, DIST);
    expect(editing.quitar).toHaveBeenCalledWith(DIST, ID, PEDIDO, 2);
    const movida = await hojas.mover(
      ID,
      PEDIDO,
      { version: 1, targetSheetId: OTRA, targetVersion: 5 },
      DIST,
    );
    expect(editing.mover).toHaveBeenCalledWith(DIST, ID, PEDIDO, {
      version: 1,
      targetSheetId: OTRA,
      targetVersion: 5,
    });
    expect([movida.source.id, movida.target.id]).toEqual([ID, OTRA]);
    await hojas.ordenar(ID, { version: 1, orderIds: [PEDIDO] }, DIST);
    expect(editing.ordenar).toHaveBeenCalledWith(DIST, ID, {
      version: 1,
      orderIds: [PEDIDO],
    });
    const opt = await hojas.optimizar(ID, { version: 1 }, DIST);
    expect(editing.optimizar).toHaveBeenCalledWith(DIST, ID, 1);
    expect(opt).toMatchObject({
      before: { durationMin: 9 },
      after: { durationMin: 5 },
      sheet: { id: ID },
    });
  });

  it('ciclo de vida: confirmar con el usuario, reabrir y cancelar con la versión; carga y PDF', async () => {
    await hojas.confirmar(
      ID,
      { version: 3, acceptLateStops: true },
      DIST,
      USUARIO,
    );
    expect(lifecycle.confirmar).toHaveBeenCalledWith(
      DIST,
      ID,
      { version: 3, acceptLateStops: true },
      USUARIO,
    );
    await hojas.reabrir(ID, { version: 4 }, DIST);
    expect(lifecycle.reabrir).toHaveBeenCalledWith(DIST, ID, 4);
    await hojas.cancelar(ID, { version: 5 }, DIST);
    expect(lifecycle.cancelar).toHaveBeenCalledWith(DIST, ID, 5);
    await hojas.cargaSugerida(ID, DIST);
    expect(query.cargaSugerida).toHaveBeenCalledWith(DIST, ID);
    const archivo = await hojas.pdf(ID, DIST);
    expect(archivo).toBeInstanceOf(StreamableFile);
    expect(archivo.getHeaders()).toMatchObject({
      type: 'application/pdf',
      length: 6,
    });
    expect(String(archivo.getHeaders().disposition)).toContain('attachment');
  });

  it('el panel es de admin y super admin', () => {
    const reflector = new Reflector();
    for (const clase of [
      RoutePlansController,
      RouteSheetsController,
      RoutePlanningSettingsController,
    ]) {
      expect(reflector.get('roles', clase as never)).toEqual([
        RoleType.ADMIN,
        RoleType.SUPER_ADMIN,
      ]);
    }
  });
});
