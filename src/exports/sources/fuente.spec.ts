import { BadRequestException } from '@nestjs/common';
import { QueryTrafficFineDto } from '../../fleet-expense/dto/traffic-fine.dto';
import { QueryOrdersDto } from '../../order/dto/query-orders.dto';
import { texto } from './columnas';
import { fuente, porOffset, SinFiltros } from './fuente';

describe('fuente', () => {
  it('rechaza un filtro que el listado no tiene', async () => {
    const f = fuente<SinFiltros, { a: string }>({
      recurso: 'x',
      descripcion: 'x',
      query: SinFiltros,
      leer: () => Promise.resolve({ filas: [], total: 0 }),
      columnas: [texto('A', (r) => r.a)],
    });

    await expect(f.preparar({ foo: '1' }, 'd1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('valida los filtros con el DTO del listado', async () => {
    const f = fuente<QueryOrdersDto, { a: string }>({
      recurso: 'x',
      descripcion: 'x',
      query: QueryOrdersDto,
      paginar: porOffset,
      leer: () => Promise.resolve({ filas: [], total: 0 }),
      columnas: [texto('A', (r) => r.a)],
    });

    await expect(
      f.preparar({ status: 'no-existe' }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignora limit, offset y page del cliente y pagina por su cuenta', async () => {
    const leer = jest.fn().mockResolvedValue({ filas: [{ a: 'x' }], total: 1 });
    const f = fuente<QueryTrafficFineDto, { a: string }>({
      recurso: 'x',
      descripcion: 'x',
      query: QueryTrafficFineDto,
      paginar: porOffset,
      leer,
      columnas: [texto('A', (r) => r.a)],
    });

    const consulta = await f.preparar(
      { limit: '1', offset: '99', page: '7' },
      'd1',
    );
    const lote = await consulta.leer(1000, 500);

    expect(leer).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500, offset: 1000 }),
      'd1',
    );
    expect(lote).toEqual({ filas: [['x']], total: 1 });
    expect(consulta.paginada).toBe(true);
  });

  it('un listado sin paginar no recibe página y se marca como no paginado', async () => {
    const leer = jest.fn().mockResolvedValue({ filas: [], total: 0 });
    const f = fuente<SinFiltros, { a: string }>({
      recurso: 'x',
      descripcion: 'x',
      query: SinFiltros,
      leer,
      columnas: [texto('A', (r) => r.a)],
    });

    const consulta = await f.preparar({}, 'd1');

    expect(consulta.paginada).toBe(false);
    expect(f.encabezados).toEqual([{ titulo: 'A', tipo: 'texto', ancho: 28 }]);
  });
});
