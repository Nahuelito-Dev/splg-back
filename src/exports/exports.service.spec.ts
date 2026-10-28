import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExportSourcesRegistry } from './export-sources.registry';
import type { ConsultaDeExporte, FuenteDeExporte } from './export.types';
import { ExportsService, TAMANO_DE_LOTE } from './exports.service';

async function leerTodo(cuerpo: AsyncIterable<unknown>): Promise<string> {
  let s = '';
  for await (const c of cuerpo) s += String(c);
  return s;
}

function armar(
  consulta: ConsultaDeExporte,
  maximo: number | undefined = 50_000,
) {
  const fuente: FuenteDeExporte = {
    recurso: 'pedidos',
    descripcion: 'x',
    encabezados: [{ titulo: 'N', tipo: 'entero', ancho: 8 }],
    preparar: jest.fn().mockResolvedValue(consulta),
  };
  const registry = {
    buscar: (r: string) => (r === 'pedidos' ? fuente : undefined),
    recursos: () => ['pedidos'],
  } as unknown as ExportSourcesRegistry;
  const config = { get: () => maximo } as unknown as ConfigService;
  return { service: new ExportsService(registry, config), fuente };
}

describe('ExportsService', () => {
  it('responde 404 si el recurso no existe', async () => {
    const { service } = armar({ paginada: false, leer: jest.fn() });

    await expect(service.preparar('nada', {}, 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('responde 400 si el formato no es csv ni xlsx', async () => {
    const { service } = armar({ paginada: false, leer: jest.fn() });

    await expect(
      service.preparar('pedidos', { format: 'pdf' }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lee todos los lotes de a TAMANO_DE_LOTE y arma el nombre del archivo', async () => {
    const total = TAMANO_DE_LOTE * 2 + 1;
    const leer = jest.fn((desde: number) =>
      Promise.resolve({
        filas: Array.from(
          { length: Math.min(TAMANO_DE_LOTE, total - desde) },
          (_, i) => [desde + i],
        ),
        total,
      }),
    );
    const { service, fuente } = armar({ paginada: true, leer });

    const exporte = await service.preparar(
      'pedidos',
      { format: 'csv', status: 'x' },
      'd1',
    );
    const texto = await leerTodo(exporte.cuerpo);

    expect(leer.mock.calls.map((c) => c[0])).toEqual([0, 500, 1000]);
    expect(texto.trim().split('\n')).toHaveLength(total + 1);
    expect(exporte.total).toBe(total);
    expect(exporte.nombreDeArchivo).toMatch(/^pedidos-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(fuente.preparar).toHaveBeenCalledWith({ status: 'x' }, 'd1');
  });

  it('responde 400 antes de enviar nada si hay más filas que el tope', async () => {
    const leer = jest.fn().mockResolvedValue({ filas: [[1]], total: 51 });
    const { service } = armar({ paginada: true, leer }, 50);

    await expect(service.preparar('pedidos', {}, 'd1')).rejects.toThrow(
      /tiene 51 filas y el máximo es 50/,
    );
  });

  it('el tope por defecto es 50.000 si no hay configuración válida', () => {
    const { service } = armar({ paginada: false, leer: jest.fn() }, undefined);

    expect(service.maximoDeFilas()).toBe(50_000);
  });

  it('un listado sin paginar se lee una sola vez', async () => {
    const leer = jest.fn().mockResolvedValue({ filas: [[1], [2]], total: 2 });
    const { service } = armar({ paginada: false, leer });

    const exporte = await service.preparar('pedidos', {}, 'd1');
    await leerTodo(exporte.cuerpo);

    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('sin filas entrega sólo el encabezado', async () => {
    const leer = jest.fn().mockResolvedValue({ filas: [], total: 0 });
    const { service } = armar({ paginada: true, leer });

    const exporte = await service.preparar('pedidos', {}, 'd1');

    expect(await leerTodo(exporte.cuerpo)).toBe('\uFEFFN\n');
  });

  it('el xlsx tiene su tipo de contenido y extensión', async () => {
    const leer = jest.fn().mockResolvedValue({ filas: [[1]], total: 1 });
    const { service } = armar({ paginada: true, leer });

    const exporte = await service.preparar('pedidos', { format: 'xlsx' }, 'd1');
    exporte.cuerpo.resume();

    expect(exporte.nombreDeArchivo.endsWith('.xlsx')).toBe(true);
    expect(exporte.tipoDeContenido).toContain('spreadsheetml');
  });
});
