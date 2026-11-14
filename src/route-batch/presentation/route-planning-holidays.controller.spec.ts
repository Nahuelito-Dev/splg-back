import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RoleType } from '../../common/constants/role-type.enum';
import { PERMISO_KEY } from '../../common/decorators/permiso.decorator';
import { RoutePlanningHoliday } from '../../order/entities/route-planning-holiday.entity';
import { RoutePlanningCalendarService } from '../application/route-planning-calendar.service';
import { DIST } from '../application/route-sheet.fixtures';
import {
  CreateRoutePlanningHolidayDto,
  ListRoutePlanningHolidaysQueryDto,
} from './dto/route-planning-holiday.dto';
import { RoutePlanningHolidaysController } from './route-planning-holidays.controller';

const feriado = Object.assign(new RoutePlanningHoliday(), {
  holidayId: 'f1',
  distributorId: DIST,
  date: '2026-12-08',
  description: 'Inmaculada Concepción',
  createdAt: new Date('2026-11-14T12:00:00Z'),
});

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

describe('feriados de la hoja de ruta', () => {
  const calendario = {
    listar: jest.fn().mockResolvedValue([feriado]),
    crear: jest.fn().mockResolvedValue(feriado),
    borrar: jest.fn().mockResolvedValue(undefined),
  };
  const ctrl = new RoutePlanningHolidaysController(
    calendario as unknown as RoutePlanningCalendarService,
  );
  const dto = {
    holidayId: 'f1',
    date: '2026-12-08',
    description: 'Inmaculada Concepción',
    createdAt: '2026-11-14T12:00:00.000Z',
  };

  it('listar, cargar y dar de baja, siempre con la distribuidora del contexto', async () => {
    expect(await ctrl.listar({ from: '2026-11-01' }, DIST)).toEqual([dto]);
    expect(calendario.listar).toHaveBeenCalledWith(DIST, {
      from: '2026-11-01',
    });
    const body = { date: '2026-12-08', description: 'Inmaculada Concepción' };
    expect(await ctrl.crear(body, DIST)).toEqual(dto);
    expect(calendario.crear).toHaveBeenCalledWith(DIST, body);
    await expect(ctrl.borrar('f1', DIST)).resolves.toBeUndefined();
    expect(calendario.borrar).toHaveBeenCalledWith(DIST, 'f1');
  });

  it('es del panel (admin y super admin) con el permiso de la hoja de ruta', () => {
    const reflector = new Reflector();
    expect(
      reflector.get('roles', RoutePlanningHolidaysController as never),
    ).toEqual([RoleType.ADMIN, RoleType.SUPER_ADMIN]);
    for (const metodo of ['listar', 'crear', 'borrar'] as const) {
      expect(
        reflector.get(
          PERMISO_KEY,
          RoutePlanningHolidaysController.prototype[metodo],
        ),
      ).toEqual(['despacho.gestionar']);
    }
  });

  it('DTOs: fecha AAAA-MM-DD válida y descripción de 2 a 120 caracteres con texto', async () => {
    const ok = { date: '2026-12-08', description: 'Feriado' };
    expect(await errores(CreateRoutePlanningHolidayDto, ok)).toEqual([]);
    expect(
      await errores(CreateRoutePlanningHolidayDto, {
        ...ok,
        date: '2026-02-30',
      }),
    ).toEqual(['date']);
    expect(
      await errores(CreateRoutePlanningHolidayDto, { ...ok, description: ' ' }),
    ).toEqual(['description']);
    expect(
      await errores(CreateRoutePlanningHolidayDto, {
        ...ok,
        description: 'x'.repeat(121),
      }),
    ).toEqual(['description']);
    expect(
      await errores(CreateRoutePlanningHolidayDto, { ...ok, extra: 1 }),
    ).toEqual(['extra']);
    expect(await errores(ListRoutePlanningHolidaysQueryDto, {})).toEqual([]);
    expect(
      await errores(ListRoutePlanningHolidaysQueryDto, {
        from: '01/11/2026',
        to: '2026-13-01',
      }),
    ).toEqual(['from', 'to']);
  });
});
