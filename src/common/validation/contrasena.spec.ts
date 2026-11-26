import { esContrasenaComun } from './contrasenas-comunes';
import { IsString, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  cumplePoliticaDeContrasena,
  EsContrasenaSegura,
  MENSAJE_CONTRASENA_COMUN,
  MENSAJE_POLITICA_CONTRASENA,
} from './contrasena';

class Dto {
  @IsString()
  @EsContrasenaSegura()
  password!: string;
}

const errores = async (password: unknown) =>
  validate(plainToInstance(Dto, { password }));

describe('política de contraseña', () => {
  it.each([
    'Abcdef12',
    'unaClaveLarga9',
    'X1xxxxxxxxxxxxxxxxxx',
    'Mi clave con espacios 7',
    'Ñandú-€ñ#2026!',
    `A1${'x'.repeat(126)}`,
  ])('acepta %s', async (clave) => {
    expect(cumplePoliticaDeContrasena(clave)).toBe(true);
    expect(await errores(clave)).toHaveLength(0);
  });

  it.each([
    ['7 caracteres', 'Abcde12'],
    ['sin mayúscula', 'abcdef12'],
    ['sin minúscula', 'ABCDEF12'],
    ['sin número', 'Abcdefgh'],
    ['vacía', ''],
    ['el mínimo viejo', 'abc123'],
  ])('rechaza %s', async (_caso, clave) => {
    expect(cumplePoliticaDeContrasena(clave)).toBe(false);
    const e = await errores(clave);
    expect(e).toHaveLength(1);
    expect(Object.values(e[0].constraints ?? {})).toContain(
      MENSAJE_POLITICA_CONTRASENA,
    );
  });

  it.each(['Test1234', 'PassWord1', 'Qwerty123', 'Splg1234'])(
    'rechaza la común %s, sin distinguir mayúsculas',
    async (clave) => {
      expect(cumplePoliticaDeContrasena(clave)).toBe(false);
      const e = await errores(clave);
      expect(e).toHaveLength(1);
      expect(Object.values(e[0].constraints ?? {})).toEqual([
        MENSAJE_CONTRASENA_COMUN,
      ]);
    },
  );

  it('rechaza más de 128 caracteres', async () => {
    const clave = `A1${'x'.repeat(127)}`;
    expect(cumplePoliticaDeContrasena(clave)).toBe(false);
    expect(await errores(clave)).toHaveLength(1);
  });

  it('rechaza lo que no es texto', () => {
    expect(cumplePoliticaDeContrasena(12345678)).toBe(false);
    expect(cumplePoliticaDeContrasena(undefined)).toBe(false);
  });
  it('una contraseña común con espacios, mayúsculas o caracteres de ancho completo sigue siendo común', () => {
    expect(esContrasenaComun('Password123 ')).toBe(true);
    expect(esContrasenaComun(' Pass word123')).toBe(true);
    expect(esContrasenaComun('Ｐａｓｓｗｏｒｄ１２３')).toBe(true);
    expect(esContrasenaComun('Garrafa-Azul-2026')).toBe(false);
  });
});
