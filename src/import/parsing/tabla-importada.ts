import { BadRequestException } from '@nestjs/common';
import {
  ColumnaDeImportacion,
  FilaCruda,
  MAX_FILAS,
} from '../domain/import.types';
import { FilaDeArchivo } from './lector-de-tabla';

/** Minúsculas, sin acentos ni signos: "Peso (kg)" y "peso kg" son el mismo encabezado. */
export function normalizarEncabezado(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Cruza el encabezado del archivo con las columnas del recurso y arma las filas
 * crudas por clave. Un encabezado que falta o que sobra es un 400: con una carga
 * todo-o-nada, ignorar en silencio una columna mal escrita descartaría datos.
 * Las filas vacías se saltean.
 */
export function armarFilas(
  archivo: FilaDeArchivo[],
  columnas: ColumnaDeImportacion[],
): FilaCruda[] {
  const [encabezado, ...datos] = archivo;
  if (!encabezado) throw new BadRequestException('El archivo está vacío');

  const porEncabezado = new Map<string, ColumnaDeImportacion>();
  for (const col of columnas) {
    porEncabezado.set(normalizarEncabezado(col.header), col);
    porEncabezado.set(normalizarEncabezado(col.key), col);
  }
  const posicion = new Map<number, ColumnaDeImportacion>();
  const desconocidas: string[] = [];
  encabezado.celdas.forEach((texto, i) => {
    if (!texto) return;
    const col = porEncabezado.get(normalizarEncabezado(texto));
    if (col) posicion.set(i, col);
    else desconocidas.push(texto);
  });
  if (desconocidas.length > 0) {
    throw new BadRequestException(
      `Columnas que no existen en la plantilla: ${desconocidas.join(', ')}`,
    );
  }
  const presentes = new Set([...posicion.values()].map((c) => c.key));
  const faltan = columnas
    .filter((c) => c.obligatoria && !presentes.has(c.key))
    .map((c) => c.header);
  if (faltan.length > 0) {
    throw new BadRequestException(
      `Faltan columnas obligatorias: ${faltan.join(', ')}`,
    );
  }
  if (presentes.size !== posicion.size) {
    throw new BadRequestException('Hay una columna repetida en el encabezado');
  }

  const ultimaColumna = Math.max(...posicion.keys());
  const conCeldasDeMas: number[] = [];
  const filas: FilaCruda[] = [];
  for (const { fila, celdas } of datos) {
    if (celdas.every((c) => c === '')) continue;
    // Una celda con dato a la derecha de la última columna corre todo lo demás: casi
    // siempre es la coma decimal en un CSV separado por comas.
    if (celdas.some((c, i) => i > ultimaColumna && c !== '')) {
      conCeldasDeMas.push(fila);
      continue;
    }
    // Toda columna tiene su celda: una opcional que no está en el archivo queda vacía.
    const celdasPorClave: Record<string, string> = Object.fromEntries(
      columnas.map((c) => [c.key, '']),
    );
    for (const [i, col] of posicion) celdasPorClave[col.key] = celdas[i] ?? '';
    filas.push({ fila, celdas: celdasPorClave });
  }
  if (conCeldasDeMas.length > 0) {
    const lista = conCeldasDeMas.slice(0, 10).join(', ');
    const resto = conCeldasDeMas.length > 10 ? '…' : '';
    const quien =
      conCeldasDeMas.length === 1
        ? `La fila ${lista} tiene`
        : `Las filas ${lista}${resto} tienen`;
    throw new BadRequestException(
      `${quien} más celdas que el encabezado: separá las columnas con «;» y usá la coma sólo para los decimales`,
    );
  }
  if (filas.length === 0) {
    throw new BadRequestException('El archivo no tiene filas para importar');
  }
  if (filas.length > MAX_FILAS) {
    throw new BadRequestException(
      `El archivo tiene ${filas.length} filas: el máximo es ${MAX_FILAS}`,
    );
  }
  return filas;
}
