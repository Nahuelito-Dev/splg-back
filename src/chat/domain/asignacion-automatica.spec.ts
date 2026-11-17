import {
  type Candidato,
  elegir,
  estaDisponible,
  GRACIA_DE_DESCONEXION_MS,
  lugarLibre,
  lugarPorCanal,
  preferidoConLugar,
  repartir,
  topeDe,
} from './asignacion-automatica';
import { Channel } from './chat.enums';

const C3 = Channel.STAFF_CUSTOMER as const;
const C2 = Channel.STAFF_DRIVER as const;
const T = 1_000_000_000;

const persona = (
  cambios: Partial<Candidato> & { userId: string },
): Candidato => ({
  canales: [C3, C2],
  disponible: true,
  tope: 5,
  abiertas: 0,
  ultimaAsignacion: null,
  ...cambios,
});

describe('asignación automática (8b): a quién le toca', () => {
  it('el que tiene más lugar libre (tope menos abiertas), no el que tiene menos abiertas', () => {
    const ana = persona({ userId: 'ana', tope: 10, abiertas: 4 }); // 6 libres
    const beto = persona({ userId: 'beto', tope: 5, abiertas: 1 }); // 4 libres
    expect(lugarLibre(ana)).toBe(6);
    expect(elegir([beto, ana], C3)?.userId).toBe('ana');
  });

  it('empate de lugar: el que hace más que no recibe una; el que nunca recibió, primero', () => {
    const vieja = persona({ userId: 'b', ultimaAsignacion: T - 60_000 });
    const nueva = persona({ userId: 'a', ultimaAsignacion: T });
    const nunca = persona({ userId: 'c', ultimaAsignacion: null });
    expect(elegir([nueva, vieja], C3)?.userId).toBe('b');
    expect(elegir([nueva, vieja, nunca], C3)?.userId).toBe('c');
    expect(elegir([nunca, vieja], C3)?.userId).toBe('c');
  });

  it('empate total: por id, para que sea estable', () => {
    expect(
      elegir([persona({ userId: 'z' }), persona({ userId: 'm' })], C3)?.userId,
    ).toBe('m');
  });

  it('en el tope no recibe; si nadie tiene lugar, nadie', () => {
    const llena = persona({ userId: 'ana', tope: 2, abiertas: 2 });
    const pasada = persona({ userId: 'beto', tope: 2, abiertas: 3 });
    expect(elegir([llena, pasada], C3)).toBeNull();
    expect(
      elegir([llena, persona({ userId: 'caro', tope: 1, abiertas: 0 })], C3)
        ?.userId,
    ).toBe('caro');
  });

  it('sólo quien atiende el canal de la conversación', () => {
    const deClientes = persona({ userId: 'ana', canales: [C3], tope: 50 });
    const deChoferes = persona({ userId: 'beto', canales: [C2] });
    expect(elegir([deClientes, deChoferes], C2)?.userId).toBe('beto');
    expect(elegir([deChoferes], C3)).toBeNull();
  });

  it('el no disponible no recibe aunque tenga lugar', () => {
    const ausente = persona({ userId: 'ana', disponible: false, tope: 50 });
    expect(elegir([ausente], C3)).toBeNull();
    expect(
      elegir([ausente, persona({ userId: 'beto', tope: 1 })], C3)?.userId,
    ).toBe('beto');
  });

  it('el tope que rige: el propio o, si no tiene, el de la empresa', () => {
    expect(topeDe(null, 5)).toBe(5);
    expect(topeDe(12, 5)).toBe(12);
    expect(topeDe(1, 50)).toBe(1);
  });
});

describe('asignación automática (8b): disponible', () => {
  const base = {
    estado: 'online' as const,
    conectado: true,
    vistoEn: T,
    enHorario: true,
  };

  it('en línea, conectada y en horario', () => {
    expect(estaDisponible(base, T)).toBe(true);
  });

  it('ausente no recibe aunque esté conectada', () => {
    expect(estaDisponible({ ...base, estado: 'away' }, T)).toBe(false);
  });

  it('fuera del horario de atención de la empresa, nadie', () => {
    expect(estaDisponible({ ...base, enHorario: false }, T)).toBe(false);
  });

  it('desconectada: sigue contando hasta 2 minutos; después, no (el estado se conserva)', () => {
    const fuera = { ...base, conectado: false, vistoEn: T };
    expect(estaDisponible(fuera, T + GRACIA_DE_DESCONEXION_MS)).toBe(true);
    expect(estaDisponible(fuera, T + GRACIA_DE_DESCONEXION_MS + 1)).toBe(false);
    expect(estaDisponible({ ...fuera, vistoEn: null }, T)).toBe(false);
  });
});

describe('asignación automática (8b): repartir la cola', () => {
  it('la más vieja primero, contando lo que ya recibió en la misma vuelta (nadie pasa su tope)', () => {
    const ana = persona({ userId: 'ana', tope: 2, abiertas: 0 });
    const beto = persona({ userId: 'beto', tope: 1, abiertas: 0 });
    const cola = ['c1', 'c2', 'c3', 'c4'].map((id) => ({
      conversationId: id,
      canal: C3,
    }));
    expect(repartir(cola, [ana, beto], T)).toEqual([
      { conversationId: 'c1', userId: 'ana' },
      // Empatan en lugar (1 y 1): beto nunca recibió, ana recién.
      { conversationId: 'c2', userId: 'beto' },
      { conversationId: 'c3', userId: 'ana' },
    ]);
    // No toca lo que recibe.
    expect(ana.abiertas).toBe(0);
  });

  it('una que nadie puede atender queda; la siguiente de otro canal, sí', () => {
    const deChoferes = persona({ userId: 'beto', canales: [C2] });
    expect(
      repartir(
        [
          { conversationId: 'c1', canal: C3 },
          { conversationId: 'c2', canal: C2 },
        ],
        [deChoferes],
        T,
      ),
    ).toEqual([{ conversationId: 'c2', userId: 'beto' }]);
  });

  it('sin nadie disponible, nada', () => {
    expect(
      repartir(
        [{ conversationId: 'c1', canal: C3 }],
        [persona({ userId: 'ana', disponible: false })],
        T,
      ),
    ).toEqual([]);
  });
});

describe('asignación automática (8b): quien ya respondió y el lugar por canal', () => {
  it('vuelve a la última persona del equipo que respondió, aunque otro tenga más lugar', () => {
    const ana = persona({ userId: 'ana', tope: 50 });
    const beto = persona({ userId: 'beto', tope: 1 });
    expect(
      repartir(
        [{ conversationId: 'c1', canal: C3, preferido: 'beto' }],
        [ana, beto],
        T,
      ),
    ).toEqual([{ conversationId: 'c1', userId: 'beto' }]);
  });

  it('si esa persona no puede (no disponible, sin lugar, sin el canal o no es del equipo), reparto normal', () => {
    const ana = persona({ userId: 'ana' });
    for (const beto of [
      persona({ userId: 'beto', disponible: false }),
      persona({ userId: 'beto', tope: 1, abiertas: 1 }),
      persona({ userId: 'beto', canales: [C2] }),
    ]) {
      const c = { conversationId: 'c1', canal: C3, preferido: 'beto' };
      expect(preferidoConLugar([ana, beto], c)).toBeNull();
      expect(repartir([c], [ana, beto], T)[0].userId).toBe('ana');
    }
    expect(
      preferidoConLugar([ana], {
        conversationId: 'c1',
        canal: C3,
        preferido: 'de-otra-empresa',
      }),
    ).toBeNull();
  });

  it('lugar por canal: el libre de los disponibles que atienden cada canal', () => {
    const porCanal = lugarPorCanal([
      persona({ userId: 'ana', tope: 5, abiertas: 2 }),
      persona({ userId: 'beto', canales: [C2], tope: 3, abiertas: 1 }),
      persona({ userId: 'caro', disponible: false, tope: 50 }),
      persona({ userId: 'dani', canales: [C3], tope: 2, abiertas: 4 }),
    ]);
    expect(porCanal.get(C3)).toBe(3);
    expect(porCanal.get(C2)).toBe(5);
  });
});
