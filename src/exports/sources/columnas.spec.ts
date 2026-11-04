import { entidad, opcion, texto } from './columnas';

type Fila = { v: unknown };
const celda = (
  columna: { valor: (f: Fila) => unknown },
  valor: unknown,
): unknown => columna.valor({ v: valor });

describe('opcion', () => {
  const estado = opcion<Fila>('Estado', 'status', (f) => f.v as string);

  it('los valores de enum salen con el texto que ve la persona', () => {
    expect(celda(estado, 'active')).toBe('Activo');
    expect(celda(estado, 'delivered')).toBe('Entregado');
  });

  it('usa la etiqueta del campo cuando el valor significa otra cosa en él', () => {
    const rol = opcion<Fila>('Rol', 'role', (f) => f.v as string);
    expect(celda(rol, 'delivery')).toBe('Chofer');
    expect(celda(estado, 'delivery')).toBe('Entrega');
  });

  it('un valor desconocido, vacío o que no es texto queda como está', () => {
    expect(celda(estado, 'otro_valor')).toBe('otro_valor');
    expect(celda(estado, 'constructor')).toBe('constructor');
    expect(celda(estado, null)).toBeNull();
    expect(celda(estado, 3)).toBe(3);
  });
});

describe('texto', () => {
  it('no toca el contenido: un texto libre que se parece a un valor queda igual', () => {
    const libre = texto<Fila>('Descripción', (f) => f.v as string);
    expect(celda(libre, 'driver')).toBe('driver');
    expect(celda(libre, 'Juan Pérez')).toBe('Juan Pérez');
  });
});

describe('entidad', () => {
  const columna = entidad<Fila>('Entidad', (f) => f.v as string);

  it('traduce la entidad auditada y deja pasar lo que no conoce', () => {
    expect(celda(columna, 'Claim')).toBe('Reclamo');
    expect(celda(columna, 'Algo')).toBe('Algo');
    expect(celda(columna, null)).toBeNull();
  });
});
