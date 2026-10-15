import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ScheduledTasksConfigDto } from './scheduled-tasks-config.dto';

const VALIDO = {
  dispatchRetrySeconds: 15,
  reservationActivationSeconds: 300,
  unpaidReservationExpirySeconds: 3600,
  unpaidMercadoPagoExpirySeconds: 1800,
  fleetAlertHour: 8,
};

async function camposInvalidos(cuerpo: Record<string, unknown>) {
  const errores = await validate(
    plainToInstance(ScheduledTasksConfigDto, cuerpo),
  );
  return errores.map((e) => e.property).sort();
}

describe('ScheduledTasksConfigDto (CU-173)', () => {
  it('acepta los valores por omisión', async () => {
    expect(await camposInvalidos(VALIDO)).toEqual([]);
  });

  it('acepta múltiplos del tic hasta 24 h (86400 s) y las horas 0 y 23', async () => {
    expect(
      await camposInvalidos({
        dispatchRetrySeconds: 300,
        reservationActivationSeconds: 86400,
        unpaidReservationExpirySeconds: 86400,
        unpaidMercadoPagoExpirySeconds: 86400,
        fleetAlertHour: 0,
      }),
    ).toEqual([]);
    expect(await camposInvalidos({ ...VALIDO, fleetAlertHour: 23 })).toEqual(
      [],
    );
    expect(
      await camposInvalidos({ ...VALIDO, dispatchRetrySeconds: 45 }),
    ).toEqual([]);
  });

  it.each([
    ['dispatchRetrySeconds', 20],
    ['reservationActivationSeconds', 400],
    ['unpaidReservationExpirySeconds', 5400],
    ['unpaidMercadoPagoExpirySeconds', 2000],
  ])('rechaza un %s que no es múltiplo del tic (%s)', async (campo, valor) => {
    expect(await camposInvalidos({ ...VALIDO, [campo]: valor })).toEqual([
      campo,
    ]);
  });

  it.each([
    ['dispatchRetrySeconds', 315],
    ['reservationActivationSeconds', 86700],
    ['unpaidReservationExpirySeconds', 90000],
    ['unpaidMercadoPagoExpirySeconds', 88200],
  ])(
    'rechaza un %s por encima de su tope (5 min el reintento, 24 h el resto) (%s)',
    async (campo, valor) => {
      expect(await camposInvalidos({ ...VALIDO, [campo]: valor })).toEqual([
        campo,
      ]);
    },
  );

  it.each([0, -15])('rechaza un intervalo no positivo (%s)', async (valor) => {
    expect(
      await camposInvalidos({ ...VALIDO, dispatchRetrySeconds: valor }),
    ).toEqual(['dispatchRetrySeconds']);
  });

  it.each([-1, 24, 8.5])('rechaza una hora fuera de 0..23 (%s)', async (h) => {
    expect(await camposInvalidos({ ...VALIDO, fleetAlertHour: h })).toEqual([
      'fleetAlertHour',
    ]);
  });

  it('rechaza un intervalo que no es entero', async () => {
    expect(
      await camposInvalidos({ ...VALIDO, dispatchRetrySeconds: 22.5 }),
    ).toEqual(['dispatchRetrySeconds']);
  });

  it('el reintento del despacho topa en 300 s (5 min), no en 24 h', async () => {
    expect(
      await camposInvalidos({ ...VALIDO, dispatchRetrySeconds: 300 }),
    ).toEqual([]);
    expect(
      await camposInvalidos({ ...VALIDO, dispatchRetrySeconds: 86400 }),
    ).toEqual(['dispatchRetrySeconds']);
  });

  it('todos los campos son opcionales; los que vienen se validan', async () => {
    expect(await camposInvalidos({})).toEqual([]);
    expect(await camposInvalidos({ fleetAlertHour: 20 })).toEqual([]);
    expect(await camposInvalidos({ fleetAlertHour: 24 })).toEqual([
      'fleetAlertHour',
    ]);
  });
});
