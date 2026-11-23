import { ChequeosService } from './chequeos.service';
import { EstadoDeComponentes } from './componentes';
import { HistorialStore } from './historial.store';
import { MuestreoEstadoService } from './muestreo.service';

const TODO_UP: EstadoDeComponentes = {
  api: 'up',
  postgres: 'up',
  redis: 'up',
  memory_rss: 'up',
  storage: 'up',
};

const T0 = Date.parse('2026-11-22T18:00:00Z');
const BLOQUE = 5 * 60_000;

function crear(
  estados: () => Promise<EstadoDeComponentes> = () => Promise.resolve(TODO_UP),
) {
  const registrar = jest.fn().mockResolvedValue(undefined);
  const store = { registrar, leer: jest.fn() } as unknown as HistorialStore;
  const estadosMock = jest.fn(estados);
  const chequeos = { estados: estadosMock } as unknown as ChequeosService;
  return {
    servicio: new MuestreoEstadoService(chequeos, store),
    registrar,
    estadosMock,
  };
}

describe('MuestreoEstadoService', () => {
  it('guarda la muestra del bloque con el estado de cada componente', async () => {
    const { servicio, registrar } = crear(() =>
      Promise.resolve({ ...TODO_UP, storage: 'down' }),
    );
    await servicio.muestrear(T0 + 30_000);
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar).toHaveBeenCalledWith(T0, {
      api: true,
      postgres: true,
      redis: true,
      memory_rss: true,
      storage: false,
    });
  });

  it('dos ticks seguidos en el mismo bloque no duplican la muestra', async () => {
    const { servicio, registrar, estadosMock } = crear();
    await servicio.muestrear(T0 + 1_000);
    await servicio.muestrear(T0 + 200_000);
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(estadosMock).toHaveBeenCalledTimes(1);
    await servicio.muestrear(T0 + BLOQUE);
    expect(registrar).toHaveBeenCalledTimes(2);
  });

  it('con Redis caído no lanza y, cuando vuelve, escribe lo pendiente con Redis como caído', async () => {
    const { servicio, registrar } = crear();
    registrar.mockRejectedValueOnce(new Error('Redis caído'));
    await expect(servicio.muestrear(T0)).resolves.toBeUndefined();
    expect(registrar).toHaveBeenCalledTimes(1);

    await servicio.muestrear(T0 + BLOQUE);
    // 1) reintento del bloque pendiente  2) el bloque nuevo
    expect(registrar).toHaveBeenCalledTimes(3);
    expect(registrar).toHaveBeenNthCalledWith(2, T0, {
      api: true,
      postgres: true,
      redis: false,
      memory_rss: true,
      storage: true,
    });
    expect(registrar).toHaveBeenNthCalledWith(
      3,
      T0 + BLOQUE,
      expect.objectContaining({ redis: true }),
    );
  });

  it('si los chequeos explotan, el muestreo no lanza', async () => {
    const { servicio, registrar } = crear(() => Promise.reject(new Error('x')));
    await expect(servicio.muestrear(T0)).resolves.toBeUndefined();
    expect(registrar).not.toHaveBeenCalled();
  });

  it('con Redis caído varios bloques seguidos retiene todos sin romper', async () => {
    const { servicio, registrar } = crear();
    registrar.mockRejectedValue(new Error('Redis caído'));
    for (let i = 0; i < 3; i++) await servicio.muestrear(T0 + i * BLOQUE);
    registrar.mockResolvedValue(undefined);
    registrar.mockClear();
    await servicio.muestrear(T0 + 3 * BLOQUE);
    expect(registrar).toHaveBeenCalledTimes(4);
    expect(registrar.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      T0,
      T0 + BLOQUE,
      T0 + 2 * BLOQUE,
      T0 + 3 * BLOQUE,
    ]);
  });

  it('el latido por minuto toma la muestra del bloque nuevo y se frena al apagar', async () => {
    jest.useFakeTimers({ now: T0 });
    try {
      const { servicio, registrar } = crear();
      await servicio.onApplicationBootstrap();
      expect(registrar).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4 * 60_000);
      expect(registrar).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(registrar).toHaveBeenCalledTimes(2);
      servicio.onApplicationShutdown();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(registrar).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
