import { partirNombreCompleto } from './nombre';

describe('partirNombreCompleto', () => {
  it.each([
    ['Ana Pérez', 'Ana', 'Pérez'],
    ['Juan Carlos Pérez', 'Juan Carlos', 'Pérez'],
    ['Juan Carlos de la Cruz', 'Juan Carlos', 'de la Cruz'],
    ['María del Valle Ortiz', 'María del Valle', 'Ortiz'],
    ['Pedro De los Santos', 'Pedro', 'De los Santos'],
    ['  Ana    Pérez  ', 'Ana', 'Pérez'],
  ])('"%s" -> nombre "%s", apellido "%s"', (completo, nombre, apellido) => {
    expect(partirNombreCompleto(completo)).toEqual({
      firstName: nombre,
      lastName: apellido,
    });
  });

  it('una sola palabra queda de nombre, con apellido de relleno', () => {
    expect(partirNombreCompleto('Madonna')).toEqual({
      firstName: 'Madonna',
      lastName: 'Sin apellido',
    });
  });

  it('vacío o sin dato nunca devuelve columnas vacías', () => {
    const vacio = { firstName: 'Sin nombre', lastName: 'Sin apellido' };
    expect(partirNombreCompleto('')).toEqual(vacio);
    expect(partirNombreCompleto('   ')).toEqual(vacio);
    expect(partirNombreCompleto(null)).toEqual(vacio);
    expect(partirNombreCompleto(undefined)).toEqual(vacio);
  });

  it('una partícula suelta no se come el nombre entero', () => {
    expect(partirNombreCompleto('de la Cruz')).toEqual({
      firstName: 'de',
      lastName: 'la Cruz',
    });
  });

  it('recorta a 80 caracteres', () => {
    const largo = 'a'.repeat(120);
    const { firstName, lastName } = partirNombreCompleto(`${largo} ${largo}`);
    expect(firstName).toHaveLength(80);
    expect(lastName).toHaveLength(80);
  });
});
