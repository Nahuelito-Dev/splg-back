import { Channel, ConversationStatus } from '../domain/chat.enums';
import { Conversation } from '../entities/conversation.entity';
import { AsignacionAutomaticaListener } from './asignacion-automatica.listener';
import type { AsignacionAutomaticaService } from './asignacion-automatica.service';
import type { CambioDeConversacion } from './chat.events';
import type { EquipoDeLaBandejaService } from './equipo-de-la-bandeja.service';

const A = 'dist-a';

function armar() {
  const asignacion = { repartirSinFallar: jest.fn(() => Promise.resolve([])) };
  const equipo = { avisar: jest.fn(() => Promise.resolve()) };
  const listener = new AsignacionAutomaticaListener(
    asignacion as unknown as AsignacionAutomaticaService,
    equipo as unknown as EquipoDeLaBandejaService,
  );
  return { listener, asignacion, equipo };
}

const conv = (cambios: Partial<Conversation> = {}) =>
  Object.assign(new Conversation(), {
    conversationId: 'c1',
    distributorId: A,
    channel: Channel.STAFF_CUSTOMER,
    status: ConversationStatus.OPEN,
    assignedToUserId: null,
    assignedAutomatically: false,
    awaitingHumanSince: null,
    ...cambios,
  });

describe('AsignacionAutomaticaListener (8b): los disparadores del reparto', () => {
  const evento = (
    c: Conversation,
    change: CambioDeConversacion,
    previousAssignedToUserId?: string | null,
  ) => ({ conversation: c, change, previousAssignedToUserId });

  it('quedó esperando a una persona sin asignar (escribió el cliente o el chofer, pidió una persona, derivó el asistente) → reparte', async () => {
    for (const channel of [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER]) {
      const { listener, asignacion } = armar();
      await listener.conversacion(
        evento(conv({ channel, awaitingHumanSince: new Date() }), 'status'),
      );
      expect(asignacion.repartirSinFallar).toHaveBeenCalledWith(A);
    }
  });

  it('un solo disparo por mensaje: el `created` de la conversación nueva (mismo objeto ya marcado) no reparte; el `status`, sí', async () => {
    const { listener, asignacion } = armar();
    const c = conv({ awaitingHumanSince: new Date() });
    await listener.conversacion(evento(c, 'created'));
    await listener.conversacion(evento(c, 'status'));
    expect(asignacion.repartirSinFallar).toHaveBeenCalledTimes(1);
  });

  it('una asignada no dispara nada por quedar esperando', async () => {
    const { listener, asignacion } = armar();
    await listener.conversacion(
      evento(
        conv({ assignedToUserId: 'ana', awaitingHumanSince: new Date() }),
        'status',
      ),
    );
    expect(asignacion.repartirSinFallar).not.toHaveBeenCalled();
  });

  it('liberó lugar: la cerró, la devolvió a la cola o se la pasaron a otro → reparte y avisa la carga', async () => {
    const cerrada = armar();
    await cerrada.listener.conversacion(
      evento(
        conv({ status: ConversationStatus.CLOSED, assignedToUserId: 'ana' }),
        'closed',
      ),
    );
    expect(cerrada.asignacion.repartirSinFallar).toHaveBeenCalledWith(A);
    expect(cerrada.equipo.avisar).toHaveBeenCalledWith(A, ['ana']);

    const devuelta = armar();
    await devuelta.listener.conversacion(evento(conv(), 'assigned', 'ana'));
    expect(devuelta.asignacion.repartirSinFallar).toHaveBeenCalledWith(A);
    expect(devuelta.equipo.avisar).toHaveBeenCalledWith(A, ['ana']);

    const pasada = armar();
    await pasada.listener.conversacion(
      evento(conv({ assignedToUserId: 'beto' }), 'assigned', 'ana'),
    );
    expect(pasada.asignacion.repartirSinFallar).toHaveBeenCalledWith(A);
    expect(pasada.equipo.avisar).toHaveBeenCalledWith(A, ['beto', 'ana']);
  });

  it('tomar una de la cola a mano no libera lugar: sólo avisa la carga de quien la tomó', async () => {
    const { listener, asignacion, equipo } = armar();
    await listener.conversacion(
      evento(conv({ assignedToUserId: 'ana' }), 'assigned', null),
    );
    expect(asignacion.repartirSinFallar).not.toHaveBeenCalled();
    expect(equipo.avisar).toHaveBeenCalledWith(A, ['ana']);
  });

  it('lo que asigna el propio reparto no lo vuelve a disparar', async () => {
    const { listener, asignacion, equipo } = armar();
    await listener.conversacion(
      evento(
        conv({ assignedToUserId: 'ana', assignedAutomatically: true }),
        'assigned',
        null,
      ),
    );
    expect(asignacion.repartirSinFallar).not.toHaveBeenCalled();
    expect(equipo.avisar).not.toHaveBeenCalled();
  });

  it('las etiquetas y el chat con la plataforma no cuentan', async () => {
    const { listener, asignacion, equipo } = armar();
    await listener.conversacion(
      evento(conv({ awaitingHumanSince: new Date() }), 'labels'),
    );
    await listener.conversacion(
      evento(
        conv({
          channel: Channel.PLATFORM_CHAT,
          awaitingHumanSince: new Date(),
        }),
        'status',
      ),
    );
    expect(asignacion.repartirSinFallar).not.toHaveBeenCalled();
    expect(equipo.avisar).not.toHaveBeenCalled();
  });

  it('se prendió la función o cambió el tope de la empresa → reparte', async () => {
    const { listener, asignacion } = armar();
    await listener.ajustes({ distributorId: A });
    expect(asignacion.repartirSinFallar).toHaveBeenCalledWith(A);
  });
});
