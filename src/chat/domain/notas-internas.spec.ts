import { Channel, MessageKind, Party } from './chat.enums';
import { MencionNoPermitidaError } from './chat.errors';
import {
  aQuienesAvisar,
  assertMencionables,
  textoDelAvisoDeMencion,
} from './notas-internas';
import { notaInternaAdmitida, veNotasInternas } from './reglas-del-mensaje';

describe('notas internas de la bandeja (4a)', () => {
  it('se menciona sólo a quien atiende el canal; uno solo que no, 400', () => {
    const atienden = new Set(['a', 'b']);
    expect(() => assertMencionables([], atienden)).not.toThrow();
    expect(() => assertMencionables(['a', 'b'], atienden)).not.toThrow();
    expect(() => assertMencionables(['a', 'x'], atienden)).toThrow(
      MencionNoPermitidaError,
    );
  });

  it('se avisa a los mencionados sin repetir y nunca al autor', () => {
    expect(aQuienesAvisar(['b', 'yo', 'b', 'c'], 'yo')).toEqual(['b', 'c']);
  });

  it('el aviso lleva el comienzo de la nota en una línea', () => {
    expect(textoDelAvisoDeMencion('  hola\n\nJuan  ')).toBe('hola Juan');
    const largo = textoDelAvisoDeMencion('x'.repeat(300));
    expect(largo).toHaveLength(140);
    expect(largo.endsWith('…')).toBe(true);
  });

  it.each<[Channel, Party, MessageKind, boolean]>([
    [Channel.PLATFORM_TICKET, Party.PLATFORM, MessageKind.TEXT, true],
    [Channel.PLATFORM_TICKET, Party.COMPANY, MessageKind.TEXT, false],
    [Channel.PLATFORM_CHAT, Party.COMPANY, MessageKind.TEXT, false],
    [Channel.PLATFORM_CHAT, Party.PLATFORM, MessageKind.TEXT, false],
    [Channel.STAFF_CUSTOMER, Party.COMPANY, MessageKind.TEXT, true],
    [Channel.STAFF_DRIVER, Party.COMPANY, MessageKind.TEXT, true],
    [Channel.STAFF_CUSTOMER, Party.COMPANY, MessageKind.SYSTEM, false],
    [Channel.STAFF_CUSTOMER, Party.CUSTOMER, MessageKind.TEXT, false],
    [Channel.STAFF_DRIVER, Party.DRIVER, MessageKind.TEXT, false],
    [Channel.STAFF_CUSTOMER, Party.SYSTEM, MessageKind.SYSTEM, true],
    [Channel.STAFF_DRIVER, Party.SYSTEM, MessageKind.SYSTEM, false],
    [Channel.STAFF_CUSTOMER, Party.SYSTEM, MessageKind.AUTO_REPLY, false],
  ])('nota interna en %s de %s (%s): %s', (canal, party, kind, admitida) => {
    expect(notaInternaAdmitida(canal, { party, kind })).toBe(admitida);
  });

  it.each<[Party, Channel, boolean]>([
    [Party.PLATFORM, Channel.PLATFORM_TICKET, true],
    [Party.COMPANY, Channel.PLATFORM_TICKET, false],
    [Party.COMPANY, Channel.PLATFORM_CHAT, false],
    [Party.COMPANY, Channel.STAFF_CUSTOMER, true],
    [Party.COMPANY, Channel.STAFF_DRIVER, true],
    [Party.CUSTOMER, Channel.STAFF_CUSTOMER, false],
    [Party.DRIVER, Channel.STAFF_DRIVER, false],
  ])('%s ve las notas de %s: %s', (party, canal, ve) => {
    expect(veNotasInternas(party, canal)).toBe(ve);
  });
});
