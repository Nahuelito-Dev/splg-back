import { depurarCambios } from './depurar-cambios';

describe('depurarCambios (CU-153: las credenciales nunca se guardan)', () => {
  it('saca contraseñas, tokens y el código de entrega, en cualquier nivel', () => {
    expect(
      depurarCambios({
        email: 'ana@splg.com',
        password: 'Secreta1',
        datos: { idToken: 'eyJ...', nombre: 'Ana' },
        code: 'A1B2C3',
      }),
    ).toEqual({
      email: 'ana@splg.com',
      password: '[depurado]',
      datos: { idToken: '[depurado]', nombre: 'Ana' },
      code: '[depurado]',
    });
  });

  it('no distingue mayúsculas en el nombre de la clave', () => {
    expect(depurarCambios({ NewPassword: 'x' })).toEqual({
      NewPassword: '[depurado]',
    });
  });

  it('recorta los textos largos', () => {
    const r = depurarCambios({ notas: 'x'.repeat(2000) });
    expect(String(r?.notas).length).toBeLessThanOrEqual(501);
  });

  it('sin cuerpo es null', () => {
    expect(depurarCambios(undefined)).toBeNull();
    expect(depurarCambios({})).toBeNull();
  });
});
