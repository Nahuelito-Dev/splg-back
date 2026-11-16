import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AcceptInvitationDto } from './accept-invitation.dto';
import {
  QueryRepurchaseForecastDto,
  QueryRepurchaseInvitationsDto,
  QueryRepurchaseStatsDto,
  RunRepurchaseDto,
  UpdateRepurchaseNoticeDto,
} from './repurchase-request.dto';

type Clase<T> = new () => T;

const errores = async <T extends object>(
  clase: Clase<T>,
  cuerpo: object,
): Promise<string[]> =>
  (await validate(plainToInstance(clase, cuerpo))).map((e) => e.property);

describe('UpdateRepurchaseNoticeDto (CU-145)', () => {
  it.each([{ days: 1 }, { days: 30 }, { days: null }, { enabled: false }, {}])(
    'acepta %j',
    async (cuerpo) => {
      expect(await errores(UpdateRepurchaseNoticeDto, cuerpo)).toEqual([]);
    },
  );

  it.each([
    { days: 0 },
    { days: 31 },
    { days: 2.5 },
    { days: '3x' },
    { days: -1 },
  ])('rechaza los días fuera de 1 a 30 o no enteros: %j', async (cuerpo) => {
    expect(await errores(UpdateRepurchaseNoticeDto, cuerpo)).toContain('days');
  });

  it('enabled tiene que ser booleano', async () => {
    expect(
      await errores(UpdateRepurchaseNoticeDto, { enabled: 'si' }),
    ).toContain('enabled');
  });
});

describe('QueryRepurchaseForecastDto (CU-146)', () => {
  it('convierte los números de la query y acepta la ventana de 1 a 90 días', async () => {
    const dto = plainToInstance(QueryRepurchaseForecastDto, {
      days: '30',
      limit: '5',
      offset: '10',
    });
    expect(dto).toMatchObject({ days: 30, limit: 5, offset: 10 });
    expect(await validate(dto)).toEqual([]);
  });

  it.each([
    { days: '0' },
    { days: '91' },
    { days: 'x' },
    { limit: '101' },
    { offset: '-1' },
  ])('rechaza %j', async (cuerpo) => {
    expect((await errores(QueryRepurchaseForecastDto, cuerpo)).length).toBe(1);
  });
});

describe('QueryRepurchaseInvitationsDto', () => {
  it('acepta estado, cliente, período y página', async () => {
    expect(
      await errores(QueryRepurchaseInvitationsDto, {
        status: 'accepted',
        userId: '8192dc67-f65d-43d4-b522-eb6f135994c8',
        from: '2026-10-01',
        to: '2026-10-31',
        limit: '10',
        offset: '0',
      }),
    ).toEqual([]);
  });

  it.each([
    [{ status: 'otro' }, 'status'],
    [{ userId: 'no-uuid' }, 'userId'],
    [{ from: 'ayer' }, 'from'],
    [{ to: '31/10' }, 'to'],
    [{ limit: '0' }, 'limit'],
    [{ offset: 'x' }, 'offset'],
  ])('rechaza %j', async (cuerpo, campo) => {
    expect(await errores(QueryRepurchaseInvitationsDto, cuerpo)).toContain(
      campo,
    );
  });
});

describe('QueryRepurchaseStatsDto y RunRepurchaseDto', () => {
  it('stats acepta días y rechaza el resto', async () => {
    expect(
      await errores(QueryRepurchaseStatsDto, {
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    ).toEqual([]);
    expect(await errores(QueryRepurchaseStatsDto, { from: 'x' })).toContain(
      'from',
    );
  });

  it('run: dryRun es booleano', async () => {
    expect(await errores(RunRepurchaseDto, { dryRun: true })).toEqual([]);
    expect(await errores(RunRepurchaseDto, { dryRun: 'true' })).toContain(
      'dryRun',
    );
  });
});

describe('AcceptInvitationDto', () => {
  it('todo es opcional', async () => {
    expect(await errores(AcceptInvitationDto, {})).toEqual([]);
  });

  it('acepta medio de pago, franja, fecha y notas', async () => {
    expect(
      await errores(AcceptInvitationDto, {
        paymentMethod: 'mercadopago',
        timeSlotId: '8dd366c7-8309-405c-9f3c-75e226972a98',
        scheduledDate: '2026-11-03',
        notes: 'Portón verde',
      }),
    ).toEqual([]);
  });

  it('el cliente no puede elegir la cuenta corriente', async () => {
    expect(
      await errores(AcceptInvitationDto, { paymentMethod: 'account' }),
    ).toContain('paymentMethod');
  });

  it.each([
    [{ timeSlotId: 'x' }, 'timeSlotId'],
    [{ scheduledDate: 'mañana' }, 'scheduledDate'],
    [{ notes: 'a'.repeat(501) }, 'notes'],
    [{ notes: 5 }, 'notes'],
  ])('rechaza %j', async (cuerpo, campo) => {
    expect(await errores(AcceptInvitationDto, cuerpo)).toContain(campo);
  });
});
