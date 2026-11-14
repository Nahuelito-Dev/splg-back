import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AddRouteSheetStopDto,
  CreateRouteSheetDto,
  MoveRouteSheetStopDto,
  PatchRoutePlanningSettingsDto,
  QueryRouteSheetsDto,
  RoutePlanDateParamDto,
  SetRouteSheetSequenceDto,
  UpdateRouteSheetDto,
} from './route-sheet-request.dto';

const U1 = '6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b';
const U2 = '7a2d3c9f-4b5e-4f6a-9b0c-1d2e3f4a5b6c';

async function errores<T extends object>(
  cls: new () => T,
  plano: object,
): Promise<string[]> {
  const e = await validate(plainToInstance(cls, plano), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return e.map((x) => x.property).sort();
}

describe('DTO de entrada de la hoja de ruta', () => {
  it('la fecha del día tiene el formato AAAA-MM-DD y existe', async () => {
    expect(
      await errores(RoutePlanDateParamDto, { date: '2026-11-14' }),
    ).toEqual([]);
    expect(
      await errores(RoutePlanDateParamDto, { date: '14/11/2026' }),
    ).toEqual(['date']);
    expect(
      await errores(RoutePlanDateParamDto, { date: '2026-02-30' }),
    ).toEqual(['date']);
  });

  it('alta: fecha obligatoria, chofer/vehículo/pedidos opcionales (uuid, a lo sumo 40)', async () => {
    expect(
      await errores(CreateRouteSheetDto, {
        planDate: '2026-11-14',
        deliveryId: U1,
        orderIds: [U1, U2],
      }),
    ).toEqual([]);
    expect(await errores(CreateRouteSheetDto, {})).toEqual(['planDate']);
    expect(
      await errores(CreateRouteSheetDto, {
        planDate: '2026-11-14',
        carId: 'x',
        orderIds: ['y'],
      }),
    ).toEqual(['carId', 'orderIds']);
  });

  it('las ediciones exigen la versión (entero ≥ 1; llega como texto en el cuerpo y se convierte)', async () => {
    expect(await errores(UpdateRouteSheetDto, { version: '3' })).toEqual([]);
    expect(await errores(UpdateRouteSheetDto, {})).toEqual(['version']);
    expect(
      await errores(UpdateRouteSheetDto, {
        version: 0,
        plannedStartAt: 'mañana',
      }),
    ).toEqual(['plannedStartAt', 'version']);
  });

  it('agregar y mover: posición entera ≥ 1 y hoja de destino con su versión', async () => {
    expect(
      await errores(AddRouteSheetStopDto, {
        version: 1,
        orderId: U1,
        position: '2',
        lock: true,
      }),
    ).toEqual([]);
    expect(
      await errores(AddRouteSheetStopDto, {
        version: 1,
        orderId: U1,
        position: 0,
      }),
    ).toEqual(['position']);
    expect(
      await errores(MoveRouteSheetStopDto, {
        version: 1,
        targetSheetId: U2,
        targetVersion: '4',
        position: '1',
      }),
    ).toEqual([]);
    expect(
      await errores(MoveRouteSheetStopDto, {
        version: 1,
        targetSheetId: 'x',
        targetVersion: 0,
      }),
    ).toEqual(['targetSheetId', 'targetVersion']);
  });

  it('orden manual: los pedidos en uuid y las fijadas también', async () => {
    expect(
      await errores(SetRouteSheetSequenceDto, {
        version: 1,
        orderIds: [U1],
        locked: [U1],
      }),
    ).toEqual([]);
    expect(
      await errores(SetRouteSheetSequenceDto, {
        version: 1,
        orderIds: ['x'],
        locked: ['y'],
      }),
    ).toEqual(['locked', 'orderIds']);
  });

  it('listado: estado de la hoja y fecha válidos', async () => {
    expect(
      await errores(QueryRouteSheetsDto, {
        status: 'draft',
        date: '2026-11-14',
      }),
    ).toEqual([]);
    expect(await errores(QueryRouteSheetsDto, { status: 'roto' })).toEqual([
      'status',
    ]);
  });

  it('parámetros: dentro de su rango', async () => {
    expect(
      await errores(PatchRoutePlanningSettingsDto, {
        maxStopsPerSheet: 40,
        trafficFactor: 1.5,
      }),
    ).toEqual([]);
    expect(
      await errores(PatchRoutePlanningSettingsDto, {
        maxStopsPerSheet: 41,
        trafficFactor: 4,
      }),
    ).toEqual(['maxStopsPerSheet', 'trafficFactor']);
  });

  it('workingDays: máscara de días ISO entera de 1 a 127', async () => {
    for (const v of [1, 31, 63, 127]) {
      expect(
        await errores(PatchRoutePlanningSettingsDto, { workingDays: v }),
      ).toEqual([]);
    }
    for (const v of [0, 128, 2.5]) {
      expect(
        await errores(PatchRoutePlanningSettingsDto, { workingDays: v }),
      ).toEqual(['workingDays']);
    }
  });

  it('confirmación automática: autoConfirm 0 o 1 y reviewMinutes entero de 0 a 720 (fuera de rango, 400)', async () => {
    for (const v of [0, 1]) {
      expect(
        await errores(PatchRoutePlanningSettingsDto, { autoConfirm: v }),
      ).toEqual([]);
    }
    for (const v of [-1, 2, 0.5]) {
      expect(
        await errores(PatchRoutePlanningSettingsDto, { autoConfirm: v }),
      ).toEqual(['autoConfirm']);
    }
    for (const v of [0, 60, 720]) {
      expect(
        await errores(PatchRoutePlanningSettingsDto, { reviewMinutes: v }),
      ).toEqual([]);
    }
    for (const v of [-1, 721, 1.5]) {
      expect(
        await errores(PatchRoutePlanningSettingsDto, { reviewMinutes: v }),
      ).toEqual(['reviewMinutes']);
    }
  });
});
