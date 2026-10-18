import { esMoto } from './vehicle-type.util';

describe('esMoto', () => {
  it.each(['Moto', 'moto', 'MOTO', 'Motocicleta', ' Moto 110cc '])(
    '%s es una moto',
    (tipo) => {
      expect(esMoto(tipo)).toBe(true);
    },
  );

  it.each(['Auto', 'Camioneta', 'Utilitario', '', null, undefined])(
    '%s no es una moto',
    (tipo) => {
      expect(esMoto(tipo)).toBe(false);
    },
  );
});
