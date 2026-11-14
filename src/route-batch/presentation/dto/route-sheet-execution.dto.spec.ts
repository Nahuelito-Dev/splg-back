import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FailedDeliveryReason } from '../../application/route-sheet-stops.service';
import {
  CloseRouteSheetDto,
  FailedStopDto,
  StartRouteSheetDto,
} from './route-sheet-execution.dto';

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

describe('DTO de entrada de la hoja en curso', () => {
  it('iniciar: acknowledgeShortages opcional y booleano; nada más', async () => {
    expect(await errores(StartRouteSheetDto, {})).toEqual([]);
    expect(
      await errores(StartRouteSheetDto, { acknowledgeShortages: true }),
    ).toEqual([]);
    expect(
      await errores(StartRouteSheetDto, { acknowledgeShortages: 'si' }),
    ).toEqual(['acknowledgeShortages']);
    expect(await errores(StartRouteSheetDto, { deliveryId: 'x' })).toEqual([
      'deliveryId',
    ]);
  });

  it('no entregada: motivo de la lista; nota opcional salvo «other» (3 a 280, recortada)', async () => {
    expect(
      await errores(FailedStopDto, {
        reason: FailedDeliveryReason.CUSTOMER_ABSENT,
      }),
    ).toEqual([]);
    expect(await errores(FailedStopDto, {})).toEqual(['reason']);
    expect(await errores(FailedStopDto, { reason: 'se fue' })).toEqual([
      'reason',
    ]);
    expect(await errores(FailedStopDto, { reason: 'other' })).toEqual(['note']);
    expect(
      await errores(FailedStopDto, { reason: 'other', note: '   ab   ' }),
    ).toEqual(['note']);
    expect(
      await errores(FailedStopDto, { reason: 'other', note: 'portón cerrado' }),
    ).toEqual([]);
    expect(
      await errores(FailedStopDto, {
        reason: 'rejected',
        note: 'x'.repeat(281),
      }),
    ).toEqual(['note']);
    expect(
      await errores(FailedStopDto, { reason: 'rejected', note: 42 }),
    ).toEqual(['note']);
    const dto = plainToInstance(FailedStopDto, {
      reason: 'other',
      note: '  portón  ',
    });
    expect(dto.note).toBe('portón');
  });

  it('cerrar: motivo obligatorio de 5 a 280 caracteres (recortado)', async () => {
    expect(
      await errores(CloseRouteSheetDto, { reason: 'Fin del día' }),
    ).toEqual([]);
    expect(await errores(CloseRouteSheetDto, {})).toEqual(['reason']);
    expect(await errores(CloseRouteSheetDto, { reason: '   abc   ' })).toEqual([
      'reason',
    ]);
    expect(
      await errores(CloseRouteSheetDto, { reason: 'x'.repeat(281) }),
    ).toEqual(['reason']);
  });
});
