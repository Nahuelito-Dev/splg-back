import { PALABRAS_DE_CORTESIA, textoParaSugerir } from './sugerencias';

describe('sugerencias: con qué texto se busca (CH-BOT §3)', () => {
  it('un saludo, un agradecimiento o un emoji solos no buscan nada', () => {
    for (const m of [
      'hola',
      'Hola!!',
      'holaaa',
      'buenas',
      'Buenas tardes',
      'buen día',
      'gracias',
      'Graciass',
      'muchas gracias!',
      'ok',
      'OK, gracias',
      'dale, genial',
      'hola, ¿cómo va?',
      '👍',
      '...',
    ]) {
      expect(textoParaSugerir(m)).toBeNull();
    }
  });

  it('con una consulta, se sacan los saludos y queda la consulta', () => {
    expect(textoParaSugerir('Hola, ¿cómo puedo pagar?')).toBe('puedo pagar');
    expect(textoParaSugerir('buenas! a qué hora reparten?')).toBe(
      'a hora reparten',
    );
    expect(textoParaSugerir('¿Llegan a Garupá? Gracias')).toBe(
      'Llegan a Garupá',
    );
  });

  it('la lista para sacar de las respuestas guardadas trae los saludos', () => {
    expect(PALABRAS_DE_CORTESIA.split(' ')).toEqual(
      expect.arrayContaining(['hola', 'buenas', 'gracias', 'ok', 'saludo']),
    );
  });
});
