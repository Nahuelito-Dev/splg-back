import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { AdminGateway } from '../../gateways/admin.gateway';
import type { PresenciaDelEquipo } from '../infrastructure/presencia-del-equipo';
import { configuracionPorDefecto } from './support-settings.service';
import type { SupportSettingsService } from './support-settings.service';
import {
  EVENTO_ESTADO_DEL_SOPORTE,
  SupportStatusService,
} from './support-status.service';

const semana = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opensAt: '09:00',
  closesAt: '18:00',
}));
// Viernes 13/11 a las 20:00 de Buenos Aires (cerrado) y a las 10:00 (abierto).
const VIERNES_NOCHE = new Date('2026-11-13T23:00:00Z');
const VIERNES_MANANA = new Date('2026-11-13T13:00:00Z');

function armar(opciones: { personas?: number; horario?: typeof semana }) {
  const config = Object.assign(configuracionPorDefecto(), {
    chatHours: opciones.horario ?? semana,
  });
  let ultimoAvisado: string | null = null;
  const presencia = {
    personasConectadas: jest.fn().mockResolvedValue(opciones.personas ?? 0),
    marcar: jest.fn().mockResolvedValue(undefined),
    quitar: jest.fn().mockResolvedValue(undefined),
    cambioElEstado: jest.fn((estado: string) => {
      const cambio = estado !== ultimoAvisado;
      ultimoAvisado = estado;
      return Promise.resolve(cambio);
    }),
  };
  const gateway = {
    conexionesLocalesDelSoporte: jest
      .fn()
      .mockReturnValue([{ userId: 'ana', socketId: 's1' }]),
  };
  const events = { emit: jest.fn() };
  const servicio = new SupportStatusService(
    {
      leer: () => Promise.resolve(config),
    } as unknown as SupportSettingsService,
    presencia as unknown as PresenciaDelEquipo,
    gateway as unknown as AdminGateway,
    events as unknown as EventEmitter2,
  );
  return { servicio, presencia, gateway, events };
}

describe('SupportStatusService (D-C26)', () => {
  it('fuera de horario: cerrado, con la próxima apertura, y la presencia aparte', async () => {
    const { servicio } = armar({ personas: 2 });
    expect(await servicio.estado(VIERNES_NOCHE)).toEqual({
      openNow: false,
      nextOpenAt: '2026-11-16T12:00:00.000Z',
      teamOnline: true,
    });
  });

  it('en horario y sin nadie conectado', async () => {
    const { servicio } = armar({ personas: 0 });
    expect(await servicio.estado(VIERNES_MANANA)).toEqual({
      openNow: true,
      nextOpenAt: null,
      teamOnline: false,
    });
  });

  it('sin horario cargado atiende siempre', async () => {
    const { servicio } = armar({ horario: [] });
    expect(await servicio.estado(VIERNES_NOCHE)).toMatchObject({
      openNow: true,
      nextOpenAt: null,
    });
  });

  it('avisa sólo cuando el estado cambia', async () => {
    const { servicio, events, presencia } = armar({ personas: 1 });
    await servicio.avisarSiCambio(VIERNES_MANANA);
    await servicio.avisarSiCambio(VIERNES_MANANA);
    presencia.personasConectadas.mockResolvedValue(0);
    await servicio.avisarSiCambio(VIERNES_MANANA);
    expect(events.emit.mock.calls).toEqual([
      [
        EVENTO_ESTADO_DEL_SOPORTE,
        { openNow: true, nextOpenAt: null, teamOnline: true },
      ],
      [
        EVENTO_ESTADO_DEL_SOPORTE,
        { openNow: true, nextOpenAt: null, teamOnline: false },
      ],
    ]);
  });

  it('una conexión del equipo entra a la presencia y una desconexión sale', async () => {
    const { servicio, presencia } = armar({});
    await servicio.conectado({ userId: 'ana', socketId: 's1' });
    await servicio.desconectado({ userId: 'ana', socketId: 's1' });
    expect(presencia.marcar).toHaveBeenCalledWith([
      { userId: 'ana', socketId: 's1' },
    ]);
    expect(presencia.quitar).toHaveBeenCalledWith({
      userId: 'ana',
      socketId: 's1',
    });
    expect(presencia.cambioElEstado).toHaveBeenCalledTimes(2);
  });

  it('el latido renueva las conexiones de esta instancia y recalcula', async () => {
    const { servicio, presencia, gateway } = armar({});
    await servicio.latido();
    expect(gateway.conexionesLocalesDelSoporte).toHaveBeenCalled();
    expect(presencia.marcar).toHaveBeenCalledWith([
      { userId: 'ana', socketId: 's1' },
    ]);
    expect(presencia.cambioElEstado).toHaveBeenCalled();
  });

  it('sin Redis no rompe: se registra y sigue', async () => {
    const { servicio, presencia, events } = armar({});
    presencia.marcar.mockRejectedValue(new Error('Redis caído'));
    await expect(servicio.latido()).resolves.toBeUndefined();
    await expect(
      servicio.conectado({ userId: 'ana', socketId: 's1' }),
    ).resolves.toBeUndefined();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
