import { ChequeosService } from './chequeos.service';
import { EstadoDeComponentes } from './componentes';
import { HistorialStore } from './historial.store';
import { PaginaEstadoService } from './pagina-estado.service';

const TODO_UP: EstadoDeComponentes = {
  api: 'up',
  postgres: 'up',
  redis: 'up',
  memory_rss: 'up',
  storage: 'up',
};
const AHORA = Date.parse('2026-11-22T18:00:00Z');

function crear(estados: EstadoDeComponentes = TODO_UP) {
  const leer = jest.fn().mockResolvedValue({
    primeraMuestra: null,
    muestras: new Map(),
  });
  const chequeosEstados = jest.fn().mockResolvedValue(estados);
  const servicio = new PaginaEstadoService(
    { estados: chequeosEstados } as unknown as ChequeosService,
    { leer, registrar: jest.fn() } as unknown as HistorialStore,
  );
  return { servicio, leer, chequeosEstados };
}

describe('PaginaEstadoService', () => {
  it('arma un componente por fila, con nombre y 90 días', async () => {
    const { servicio } = crear();
    const m = await servicio.modelo(AHORA);
    expect(m.general).toBe('ok');
    expect(m.componentes.map((c) => c.nombre)).toEqual([
      'API',
      'Base de datos',
      'Redis',
      'Memoria',
      'Almacenamiento',
    ]);
    expect(m.componentes[0].historial.dias).toHaveLength(90);
    expect(m.historialDisponible).toBe(true);
  });

  it('un componente caído da funcionamiento parcial; la base caída, caída', async () => {
    const parcial = await crear({ ...TODO_UP, redis: 'down' }).servicio.modelo(
      AHORA,
    );
    expect(parcial.general).toBe('parcial');
    const caida = await crear({ ...TODO_UP, postgres: 'down' }).servicio.modelo(
      AHORA,
    );
    expect(caida.general).toBe('caida');
  });

  it('con Redis caído muestra la página igual, avisando que no hay historial', async () => {
    const { servicio, leer } = crear({ ...TODO_UP, redis: 'down' });
    leer.mockRejectedValue(new Error('Redis caído'));
    const m = await servicio.modelo(AHORA);
    expect(m.historialDisponible).toBe(false);
    expect(m.componentes[2].actual).toBe('down');
  });

  it('el estado actual se chequea en cada pedido; sólo el historial se reutiliza', async () => {
    const { servicio, chequeosEstados, leer } = crear();
    await servicio.modelo(AHORA);
    await servicio.modelo(AHORA + 10_000);
    expect(chequeosEstados).toHaveBeenCalledTimes(2);
    expect(leer).toHaveBeenCalledTimes(1);
    await servicio.modelo(AHORA + 16_000);
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('un componente que cae se ve en el pedido siguiente aunque el historial esté en caché', async () => {
    const { servicio, chequeosEstados } = crear();
    expect((await servicio.modelo(AHORA)).general).toBe('ok');
    chequeosEstados.mockResolvedValue({ ...TODO_UP, postgres: 'down' });
    expect((await servicio.modelo(AHORA + 1_000)).general).toBe('caida');
  });
});
