import { ValidationPipe } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type {
  Columna,
  ConsultaDeExporte,
  DefinicionDeFuente,
  FuenteDeExporte,
  Pagina,
} from '../export.types';

const ANCHO_POR_TIPO = {
  texto: 28,
  codigo: 18,
  entero: 12,
  decimal: 14,
  moneda: 16,
  fecha: 13,
  fechaHora: 18,
  booleano: 8,
} as const;

/** Mismo criterio de validación que el resto de la API: sólo los filtros del listado. */
const validador = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/** El exporte baja todo: la paginación la maneja el back, no el cliente. */
const CLAVES_DE_PAGINACION = ['limit', 'offset', 'page'] as const;

export function sinPaginacion(
  filtros: Record<string, unknown>,
): Record<string, unknown> {
  const resto = { ...filtros };
  for (const clave of CLAVES_DE_PAGINACION) delete resto[clave];
  return resto;
}

async function validarFiltros<Q extends object>(
  clase: Type<Q>,
  filtros: Record<string, unknown>,
): Promise<Q> {
  const validado: unknown = await validador.transform(sinPaginacion(filtros), {
    type: 'query',
    metatype: clase,
  });
  if (!(validado instanceof clase)) {
    throw new TypeError(`Los filtros no se convirtieron a ${clase.name}`);
  }
  return validado;
}

/**
 * Convierte la definición tipada de un recurso en una fuente uniforme. Los
 * filtros se validan contra el mismo DTO de consulta que el listado, así el
 * exporte respeta exactamente sus reglas.
 */
export function fuente<Q extends object, F>(
  def: DefinicionDeFuente<Q, F>,
): FuenteDeExporte {
  return {
    recurso: def.recurso,
    descripcion: def.descripcion,
    encabezados: def.columnas.map((c: Columna<F>) => ({
      titulo: c.titulo,
      tipo: c.tipo,
      ancho: c.ancho ?? ANCHO_POR_TIPO[c.tipo],
    })),
    preparar: async (filtros, distribuidoraId): Promise<ConsultaDeExporte> => {
      const query = await validarFiltros(def.query, filtros);
      const paginar = def.paginar;
      return {
        paginada: paginar !== undefined,
        leer: async (desde, lote) => {
          if (paginar) {
            const pagina: Pagina = {
              limit: lote,
              offset: desde,
              page: Math.floor(desde / lote) + 1,
            };
            paginar(query, pagina);
          }
          const { filas, total } = await def.leer(query, distribuidoraId);
          return {
            filas: filas.map((fila) => def.columnas.map((c) => c.valor(fila))),
            total,
          };
        },
      };
    },
  };
}

/** Filtros de un listado que no filtra por nada: cualquier parámetro es un error. */
export class SinFiltros {}

/** Para listados con `limit` y `offset`. */
export const porOffset = (
  query: { limit?: number; offset?: number },
  p: Pagina,
): void => {
  query.limit = p.limit;
  query.offset = p.offset;
};

/** Para listados con `limit` y `page`. */
export const porPagina = (
  query: { limit?: number; page?: number },
  p: Pagina,
): void => {
  query.limit = p.limit;
  query.page = p.page;
};
