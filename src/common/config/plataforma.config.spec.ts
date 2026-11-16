import {
  leerConfiguracionDePlataforma,
  NOMBRE_DE_PLATAFORMA_POR_DEFECTO,
} from './plataforma.config';

describe('configuración de la plataforma', () => {
  it('sin variables: el nombre neutro, también como razón social', () => {
    expect(leerConfiguracionDePlataforma({})).toEqual({
      name: NOMBRE_DE_PLATAFORMA_POR_DEFECTO,
      legalName: NOMBRE_DE_PLATAFORMA_POR_DEFECTO,
      supportEmail: null,
    });
  });

  it('toma las tres variables, sin espacios de más', () => {
    expect(
      leerConfiguracionDePlataforma({
        PLATFORM_NAME: '  Gasnet ',
        PLATFORM_LEGAL_NAME: 'Gasnet S.A.',
        PLATFORM_SUPPORT_EMAIL: 'soporte@gasnet.test',
      }),
    ).toEqual({
      name: 'Gasnet',
      legalName: 'Gasnet S.A.',
      supportEmail: 'soporte@gasnet.test',
    });
  });

  it('una variable vacía cuenta como no puesta', () => {
    expect(
      leerConfiguracionDePlataforma({
        PLATFORM_NAME: '   ',
        PLATFORM_SUPPORT_EMAIL: '',
      }),
    ).toMatchObject({ name: 'SPLG', supportEmail: null });
  });
});
