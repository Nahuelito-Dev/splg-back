import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import {
  QueryPlatformCompaniesDto,
  SetOwnedByPlatformDto,
} from './platform-companies.dto';

async function consulta(query: Record<string, unknown>) {
  const dto = plainToInstance(QueryPlatformCompaniesDto, query);
  const errores = await validate(dto);
  return { dto, campos: errores.map((e) => e.property).sort() };
}

describe('QueryPlatformCompaniesDto', () => {
  it('sin filtros pagina de a 50 desde el principio', async () => {
    const { dto, campos } = await consulta({});
    expect(campos).toEqual([]);
    expect(dto).toMatchObject({ limit: 50, offset: 0 });
    expect(dto.ownedByPlatform).toBeUndefined();
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('ownedByPlatform=%s de la query es booleano', async (texto, valor) => {
    const { dto, campos } = await consulta({ ownedByPlatform: texto });
    expect(campos).toEqual([]);
    expect(dto.ownedByPlatform).toBe(valor);
  });

  it('convierte la paginación de texto a número', async () => {
    const { dto, campos } = await consulta({
      limit: '10',
      offset: '20',
      status: DistributorStatus.ACTIVE,
    });
    expect(campos).toEqual([]);
    expect(dto).toMatchObject({ limit: 10, offset: 20 });
  });

  it.each([
    [
      'marca que no es true/false',
      { ownedByPlatform: 'si' },
      ['ownedByPlatform'],
    ],
    ['estado desconocido', { status: 'otro' }, ['status']],
    ['límite 0', { limit: '0' }, ['limit']],
    ['límite mayor a 200', { limit: '201' }, ['limit']],
    ['desplazamiento negativo', { offset: '-1' }, ['offset']],
  ])('%s → inválido', async (_caso, query, esperado) => {
    expect((await consulta(query)).campos).toEqual(esperado);
  });
});

describe('SetOwnedByPlatformDto', () => {
  async function campos(cuerpo: Record<string, unknown>) {
    const errores = await validate(
      plainToInstance(SetOwnedByPlatformDto, cuerpo),
    );
    return errores.map((e) => e.property);
  }

  it('acepta true y false', async () => {
    expect(await campos({ ownedByPlatform: true })).toEqual([]);
    expect(await campos({ ownedByPlatform: false })).toEqual([]);
  });

  it.each([
    ['falta la marca', {}],
    ['la marca es texto', { ownedByPlatform: 'true' }],
  ])('%s → inválido', async (_caso, cuerpo) => {
    expect(await campos(cuerpo)).toEqual(['ownedByPlatform']);
  });
});
