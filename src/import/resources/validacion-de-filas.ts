import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  BadRequestDomainError,
  ConflictDomainError,
  conDetalle,
  NotFoundDomainError,
} from '../../common/errors/domain.error';
import { ColumnaDeImportacion, ErrorDeFila } from '../domain/import.types';

/**
 * "1.234,56", "12,5" y "12.5" son el mismo tipo de número: con coma, los puntos
 * son de miles. `null` si no es un número.
 */
export function parsearNumero(texto: string): number | null {
  const limpio = texto.replace(/\s/g, '');
  if (limpio === '') return null;
  // Convención argentina: la coma es el decimal y el punto agrupa miles. Sin coma,
  // un punto seguido de grupos de tres dígitos también es de miles («12.500»).
  const normal = limpio.includes(',')
    ? limpio.replace(/\./g, '').replace(',', '.')
    : /^-?\d{1,3}(\.\d{3})+$/.test(limpio)
      ? limpio.replace(/\./g, '')
      : limpio;
  if (!/^-?\d+(\.\d+)?$/.test(normal)) return null;
  return Number(normal);
}

/** Texto de la celda a número; si no es un número, agrega el error y devuelve `undefined`. */
export function numeroDeCelda(
  texto: string,
  fila: number,
  columna: ColumnaDeImportacion,
  errores: ErrorDeFila[],
): number | undefined {
  if (texto === '') return undefined;
  const numero = parsearNumero(texto);
  if (numero === null) {
    errores.push({
      fila,
      columna: columna.header,
      mensaje: `"${texto}" no es un número`,
    });
    return undefined;
  }
  return numero;
}

/** Clave para comparar tipos, depósitos y CUIT sin mayúsculas ni espacios de los bordes. */
export function claveNormal(texto: string): string {
  return texto.trim().toLowerCase();
}

function numeroDelMensaje(mensaje: string, patron: RegExp): string {
  return patron.exec(mensaje)?.[1] ?? '';
}

/**
 * Los mensajes por defecto de `class-validator` están en inglés; los que
 * escribió cada DTO ya están en castellano y se conservan (con el encabezado de
 * la columna en lugar del nombre de la propiedad).
 */
function mensajeEnCastellano(
  restriccion: string,
  mensaje: string,
  propiedad: string,
  encabezado: string,
  celdaVacia: boolean,
): string {
  if (celdaVacia) return 'es obligatorio';
  const ingles = /\b(must|should)\b/.test(mensaje);
  if (!ingles) {
    return mensaje.replace(new RegExp(`^${propiedad}(?=[ :])`), encabezado);
  }
  switch (restriccion) {
    case 'maxLength':
      return `supera el máximo de ${numeroDelMensaje(mensaje, /(\d+) characters/)} caracteres`;
    case 'isInt':
      return 'tiene que ser un número entero';
    case 'isNumber':
    case 'isNumberString':
      return 'tiene que ser un número';
    case 'isPositive':
      return 'tiene que ser mayor que 0';
    case 'min':
      return `no puede ser menor que ${numeroDelMensaje(mensaje, /not be less than (-?\d+)/)}`;
    case 'max':
      return `no puede ser mayor que ${numeroDelMensaje(mensaje, /not be greater than (-?\d+)/)}`;
    case 'isEmail':
      return 'no es un email válido';
    case 'isUuid':
      return 'no es un identificador válido';
    case 'isString':
    case 'isNotEmpty':
      return 'es obligatorio';
    default:
      return 'tiene un valor no válido';
  }
}

export interface ResultadoDeDto<T> {
  dto: T | null;
  errores: ErrorDeFila[];
}

/**
 * Valida una fila con el DTO del alta unitaria: las mismas reglas, sin
 * duplicarlas. Devuelve la instancia ya transformada (CUIT sin guiones, textos
 * recortados) para guardarla normalizada.
 */
export async function validarConDto<T extends object>(
  clase: ClassConstructor<T>,
  plano: Record<string, unknown>,
  fila: number,
  columnas: ColumnaDeImportacion[],
  celdas: Record<string, string>,
): Promise<ResultadoDeDto<T>> {
  const dto = plainToInstance(clase, plano);
  const fallas: ValidationError[] = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const errores: ErrorDeFila[] = [];
  for (const falla of fallas) {
    const columna = columnas.find((c) => c.key === falla.property);
    const encabezado = columna?.header ?? falla.property;
    for (const [restriccion, mensaje] of Object.entries(
      falla.constraints ?? {},
    )) {
      const texto = mensajeEnCastellano(
        restriccion,
        mensaje,
        falla.property,
        encabezado,
        (celdas[falla.property] ?? '') === '',
      );
      // Un campo vacío incumple varias restricciones a la vez: se dice una vez.
      if (
        !errores.some((e) => e.columna === encabezado && e.mensaje === texto)
      ) {
        errores.push({ fila, columna: encabezado, mensaje: texto });
      }
    }
  }
  return { dto: errores.length === 0 ? dto : null, errores };
}

/**
 * Antepone el contexto (fila, depósito) al mensaje de un error de negocio,
 * conservando su estado HTTP. Lo que no es de negocio (la base) pasa sin tocar.
 */
export function conContexto(error: unknown, contexto: string): unknown {
  if (error instanceof HttpException) {
    return conDetalle(
      new HttpException(`${contexto}: ${error.message}`, error.getStatus()),
      error,
    );
  }
  if (error instanceof BadRequestDomainError) {
    return conDetalle(
      new BadRequestException(`${contexto}: ${error.message}`),
      error,
    );
  }
  if (error instanceof NotFoundDomainError) {
    return conDetalle(
      new NotFoundException(`${contexto}: ${error.message}`),
      error,
    );
  }
  if (error instanceof ConflictDomainError) {
    return conDetalle(
      new ConflictException(`${contexto}: ${error.message}`),
      error,
    );
  }
  return error;
}
