import type { DataSource } from 'typeorm';
import type { StaffPermissionsService } from '../../admin/staff-permissions.service';
import type { EntityPhotoService } from '../../s3/entity-photo.service';
import { Channel, Party } from '../domain/chat.enums';
import { ConversacionNoEncontradaError } from '../domain/chat.errors';
import { Conversation } from '../entities/conversation.entity';
import type {
  BandejaReadModel,
  PersonaDelPersonal,
} from '../infrastructure/bandeja-read-model';
import { type ActorDeLaBandeja, BandejaAcceso } from './bandeja-acceso';
import { BandejaEquipoService } from './bandeja-equipo.service';

const D = 'dist-a';
const personal: ActorDeLaBandeja = {
  party: Party.COMPANY,
  userId: 'adm-1',
  distributorId: D,
  canales: [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER],
  permisos: ['mensajes.clientes', 'mensajes.choferes'],
};

const persona = (
  userId: string,
  cambios: Partial<PersonaDelPersonal> = {},
): PersonaDelPersonal => ({
  userId,
  fullName: `Nombre de ${userId}`,
  photoKey: null,
  todos: false,
  permisos: [],
  ...cambios,
});

function armar(
  opciones: {
    canal?: Channel;
    equipo?: PersonaDelPersonal[];
    noExiste?: boolean;
  } = {},
) {
  const acceso = new BandejaAcceso(
    {} as DataSource,
    {} as StaffPermissionsService,
  );
  const buscar = jest.spyOn(acceso, 'buscar').mockImplementation(() =>
    opciones.noExiste
      ? Promise.reject(new ConversacionNoEncontradaError())
      : Promise.resolve(
          Object.assign(new Conversation(), {
            conversationId: 'conv-1',
            distributorId: D,
            channel: opciones.canal ?? Channel.STAFF_CUSTOMER,
          }),
        ),
  );
  const lectura = {
    resumen: jest.fn().mockResolvedValue({
      unassigned: 1,
      mine: 2,
      awaitingHuman: 3,
      unread: 4,
    }),
    personalDeLaEmpresa: jest.fn().mockResolvedValue(opciones.equipo ?? []),
  };
  const fotos = {
    urlDe: jest.fn((key: string | null) =>
      Promise.resolve(key ? `https://firmada/${key}` : null),
    ),
  };
  const servicio = new BandejaEquipoService(
    acceso,
    lectura as unknown as BandejaReadModel,
    fotos as unknown as EntityPhotoService,
  );
  return { servicio, lectura, buscar, fotos };
}

describe('BandejaEquipoService: resumen de la bandeja', () => {
  it('de la empresa de quien pide, de los canales que atiende y con su lectura', async () => {
    const { servicio, lectura } = armar();
    const soloChoferes: ActorDeLaBandeja = {
      ...personal,
      canales: [Channel.STAFF_DRIVER],
    };
    expect(await servicio.resumen(soloChoferes)).toEqual({
      unassigned: 1,
      mine: 2,
      awaitingHuman: 3,
      unread: 4,
    });
    expect(lectura.resumen).toHaveBeenCalledWith(D, [Channel.STAFF_DRIVER], {
      party: Party.COMPANY,
      userId: 'adm-1',
    });
  });
});

describe('BandejaEquipoService: a quién se le puede asignar', () => {
  const equipo = [
    persona('clientes', { permisos: ['mensajes.clientes'] }),
    persona('choferes', { permisos: ['mensajes.choferes'] }),
    persona('sistema', { todos: true, photoKey: 'f/sistema.jpg' }),
    persona('otro', { permisos: ['pedidos.ver', 'mensajes.configurar'] }),
    persona('viejo', { permisos: ['permiso.que.ya.no.existe'] }),
  ];

  it('en una de clientes, quien tiene `mensajes.clientes` y el rol de sistema', async () => {
    const { servicio, lectura, buscar } = armar({ equipo });
    const r = await servicio.paraAsignar(personal, 'conv-1');
    expect(r.map((p) => p.userId)).toEqual(['clientes', 'sistema']);
    expect(buscar).toHaveBeenCalledWith(personal, 'conv-1');
    // Sólo el personal de la empresa de quien pide.
    expect(lectura.personalDeLaEmpresa).toHaveBeenCalledWith(D);
  });

  it('en una de choferes, quien tiene `mensajes.choferes` y el rol de sistema', async () => {
    const { servicio } = armar({ equipo, canal: Channel.STAFF_DRIVER });
    const r = await servicio.paraAsignar(personal, 'conv-1');
    expect(r.map((p) => p.userId)).toEqual(['choferes', 'sistema']);
  });

  it('con la foto firmada si tiene; sin foto, sin el campo', async () => {
    const { servicio } = armar({ equipo });
    const r = await servicio.paraAsignar(personal, 'conv-1');
    expect(r).toEqual([
      { userId: 'clientes', fullName: 'Nombre de clientes' },
      {
        userId: 'sistema',
        fullName: 'Nombre de sistema',
        photoUrl: 'https://firmada/f/sistema.jpg',
      },
    ]);
  });

  it('una conversación que no existe, de otra empresa o de un canal que no atiende → 404, sin mirar al equipo', async () => {
    const { servicio, lectura } = armar({ equipo, noExiste: true });
    await expect(servicio.paraAsignar(personal, 'conv-1')).rejects.toThrow(
      ConversacionNoEncontradaError,
    );
    expect(lectura.personalDeLaEmpresa).not.toHaveBeenCalled();
  });

  it('sin nadie que atienda el canal, lista vacía', async () => {
    const { servicio } = armar({ equipo: [equipo[3]] });
    expect(await servicio.paraAsignar(personal, 'conv-1')).toEqual([]);
  });
});
