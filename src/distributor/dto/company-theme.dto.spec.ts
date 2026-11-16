import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompanyThemeDto } from './company-theme.dto';

async function revisar(cuerpo: Record<string, unknown>) {
  const dto = plainToInstance(CompanyThemeDto, cuerpo);
  const errores = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, campos: errores.map((e) => e.property).sort() };
}

describe('CompanyThemeDto', () => {
  it('normaliza el color a mayúsculas y el nombre recortado', async () => {
    const { dto, campos } = await revisar({
      primaryColor: ' #1d4ed8 ',
      accentColor: '#b27a00',
      displayName: '  Nahuel   Gas ',
    });
    expect(campos).toEqual([]);
    expect(dto).toMatchObject({
      primaryColor: '#1D4ED8',
      accentColor: '#B27A00',
      displayName: 'Nahuel Gas',
    });
  });

  it('acento y nombre son opcionales y aceptan null; un nombre vacío es null', async () => {
    expect((await revisar({ primaryColor: '#1D4ED8' })).campos).toEqual([]);
    const { dto, campos } = await revisar({
      primaryColor: '#1D4ED8',
      accentColor: null,
      displayName: '   ',
    });
    expect(campos).toEqual([]);
    expect(dto.displayName).toBeNull();
  });

  it.each([
    [{}, ['primaryColor']],
    [{ primaryColor: '#FFF' }, ['primaryColor']],
    [{ primaryColor: 'rojo' }, ['primaryColor']],
    [{ primaryColor: '#12345G' }, ['primaryColor']],
    [{ primaryColor: 123456 }, ['primaryColor']],
    [{ primaryColor: '#1D4ED8', accentColor: 'azul' }, ['accentColor']],
    [{ primaryColor: '#1D4ED8', displayName: 'N' }, ['displayName']],
    [
      { primaryColor: '#1D4ED8', displayName: '<script>x</script>' },
      ['displayName'],
    ],
    [{ primaryColor: '#1D4ED8', displayName: 'x'.repeat(61) }, ['displayName']],
    [{ primaryColor: '#1D4ED8', distributorId: 'otra' }, ['distributorId']],
  ])('rechaza %j', async (cuerpo, esperados) => {
    expect((await revisar(cuerpo)).campos).toEqual(esperados);
  });

  it('el mensaje de formato nombra el campo', async () => {
    const errores = await validate(
      plainToInstance(CompanyThemeDto, { primaryColor: 'rojo' }),
    );
    expect(Object.values(errores[0].constraints ?? {})).toContain(
      'primaryColor: tiene que ser un color #RRGGBB',
    );
  });
});
