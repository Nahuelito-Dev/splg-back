import type { DataSource } from 'typeorm';
import { Party } from '../domain/chat.enums';
import { ChatReadModel, condicionDeNoLeido } from './chat-read-model';

/** Base que anota el SQL de cada consulta y devuelve lo que se le diga. */
function base(respuesta: unknown[]) {
  const sql: string[] = [];
  const ds = {
    query: (q: string) => {
      sql.push(q);
      return Promise.resolve(respuesta);
    },
  } as unknown as DataSource;
  return { sql, lectura: new ChatReadModel(ds) };
}

describe('ChatReadModel: qué cuenta como «sin leer» (relevamiento B2)', () => {
  it('nunca cuenta los mensajes de sistema ni los de la propia punta', () => {
    const c = condicionDeNoLeido('$3');
    expect(c).toContain(`m."kind" <> 'system'`);
    expect(c).toContain('m."sender_party" <> $3');
  });

  it('los no leídos de cada conversación, el resumen de la empresa y el de la plataforma usan esa condición', async () => {
    const { sql, lectura } = base([]);
    await lectura.noLeidos(['c1'], { party: Party.COMPANY, userId: 'a' });
    await lectura.resumenDeLaEmpresa('dist-a', 'a');
    await lectura.resumenDeLaPlataforma('s');
    expect(sql.map((q) => q.includes(`m."kind" <> 'system'`))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('los resúmenes leen los números de la base (o cero si no hay nada)', async () => {
    const empresa = base([{ chat: '3', tickets: '2' }]);
    const plataforma = base([
      {
        chats_unread: '1',
        chats_unassigned: '4',
        tickets_unread: '5',
        tickets_unassigned: '0',
      },
    ]);
    const vacio = base([]);
    expect({
      empresa: await empresa.lectura.resumenDeLaEmpresa('dist-a', 'a'),
      plataforma: await plataforma.lectura.resumenDeLaPlataforma('s'),
      vacio: await vacio.lectura.resumenDeLaEmpresa('dist-a', 'a'),
    }).toEqual({
      empresa: { chatUnread: 3, ticketsUnread: 2 },
      plataforma: {
        chatsUnread: 1,
        chatsUnassigned: 4,
        ticketsUnread: 5,
        ticketsUnassigned: 0,
      },
      vacio: { chatUnread: 0, ticketsUnread: 0 },
    });
  });

  it('la lectura propia es de esa persona y vacía sin conversaciones', async () => {
    const { sql, lectura } = base([
      { conversation_id: 'c1', last_read_seq: '5' },
    ]);
    expect(await lectura.lecturaPropia([], 'a')).toEqual(new Map());
    expect(await lectura.lecturaPropia(['c1'], 'a')).toEqual(
      new Map([['c1', 5]]),
    );
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('"conversation_read_state"');
    expect(sql[0]).toContain('"user_id" = $2');
  });
});
