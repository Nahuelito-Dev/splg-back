import {
  avisoDeRecibidoPorDefecto,
  respuestaAutomatica,
  type SituacionDelChat,
} from './respuestas-automaticas';
import { avisoDeRecibido } from '../application/platform-chat.service';
import { condicionDeNoLeido } from '../infrastructure/chat-read-model';
import { MessageKind, Party, SystemCode } from './chat.enums';
import type { Conversation } from '../entities/conversation.entity';

const base: SituacionDelChat = {
  enHorario: true,
  avisoDeRecibidoHabilitado: true,
  yaSeAvisoRecibido: false,
  plataformaYaEscribio: false,
  yaSeRespondioFueraDeHorario: false,
};

describe('respuestas automáticas del chat con la plataforma (D-C29)', () => {
  it('en horario, al primer mensaje de la apertura: el aviso de recibido', () => {
    expect(respuestaAutomatica(base)).toBe('recibido');
  });

  it('una sola vez por apertura, nunca si la plataforma ya escribió o si está apagado', () => {
    expect([
      respuestaAutomatica({ ...base, yaSeAvisoRecibido: true }),
      respuestaAutomatica({ ...base, plataformaYaEscribio: true }),
      respuestaAutomatica({ ...base, avisoDeRecibidoHabilitado: false }),
    ]).toEqual([null, null, null]);
  });

  it('fuera de horario: la que ofrece el ticket, una vez hasta que responda la plataforma', () => {
    expect([
      respuestaAutomatica({ ...base, enHorario: false }),
      respuestaAutomatica({
        ...base,
        enHorario: false,
        yaSeRespondioFueraDeHorario: true,
      }),
    ]).toEqual(['fuera_de_horario', null]);
  });

  it('el aviso es un mensaje de sistema: no es primera respuesta (no es de la plataforma) ni cuenta como sin leer', () => {
    const m = avisoDeRecibido(
      { conversationId: 'c1', distributorId: 'dist-a' } as Conversation,
      avisoDeRecibidoPorDefecto('OrixTech'),
    );
    expect(m).toMatchObject({
      senderParty: Party.SYSTEM,
      senderUserId: null,
      kind: MessageKind.SYSTEM,
      systemCode: SystemCode.RECEIVED_ACK,
      body: 'Recibimos tu mensaje. Alguien del equipo de OrixTech te va a atender a la brevedad.',
    });
    expect(condicionDeNoLeido('$3')).toContain(`"kind" <> 'system'`);
  });
});
