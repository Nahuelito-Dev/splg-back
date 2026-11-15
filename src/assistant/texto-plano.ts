import { BadRequestException } from '@nestjs/common';
import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Las reglas del texto de una pregunta frecuente, en un solo lugar: las usan
 * el DTO, el servicio y (con el mismo patrón) los CHECK de la base.
 */

/**
 * HTML (DISENO-CH-BOT §5): una etiqueta (`<b>`, `</p>`, `<!--`) o una entidad
 * (`&` seguido de una letra o `#`, con o sin `;`: `&amp;`, `&lt`, `&#60;`).
 * Un `<` o un `&` sueltos («< 5 kg», «3 & 4 kg») son texto.
 */
export const HTML = /<[A-Za-z/!?]|&[A-Za-z#]/;

/** Los mismos patrones, para los CHECK de la base (sintaxis de Postgres). */
export const HTML_EN_LA_BASE = {
  etiqueta: `<[A-Za-z/!?]`,
  entidad: `&[A-Za-z#]`,
} as const;

export const tieneHtml = (texto: string): boolean => HTML.test(texto);

/**
 * El largo como lo cuenta Postgres (`char_length`, `varchar(n)`): puntos de
 * código. `class-validator` (`@Length`) no cuenta los selectores de variación
 * (U+FE0F de «✔️»), así que un texto en el límite pasaba el DTO y la base lo
 * rechazaba con 22001.
 */
export const largoEnLaBase = (texto: string): number => [...texto].length;

/** Largos de cada campo (sin los espacios de los bordes, como `btrim`). */
export const LARGOS = {
  question: { min: 5, max: 200, nombre: 'La pregunta' },
  answer: { min: 1, max: 1500, nombre: 'La respuesta' },
} as const;

/** Valida el largo como lo cuenta la base. */
export function LargoEnLaBase(
  min: number,
  max: number,
  options?: ValidationOptions,
) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'largoEnLaBase',
      target: object.constructor,
      propertyName,
      constraints: [min, max],
      options: {
        message: `tiene que tener entre ${min} y ${max} caracteres`,
        ...options,
      },
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' &&
          largoEnLaBase(valor) >= min &&
          largoEnLaBase(valor) <= max,
      },
    });
  };
}

/**
 * La segunda capa (servicio): el mismo control que el DTO, para que ningún
 * camino que no pase por el DTO (B3, un script) llegue a la base con un texto
 * que la base rechazaría con un 500.
 */
export function assertTextoValido(
  campos: Partial<Record<keyof typeof LARGOS, string>>,
): void {
  for (const campo of Object.keys(LARGOS) as Array<keyof typeof LARGOS>) {
    const texto = campos[campo];
    if (texto === undefined) continue;
    const { min, max, nombre } = LARGOS[campo];
    const largo = largoEnLaBase(texto.trim());
    if (largo < min || largo > max) {
      throw new BadRequestException(
        `${nombre} tiene que tener entre ${min} y ${max} caracteres`,
      );
    }
    if (tieneHtml(texto)) {
      throw new BadRequestException(
        `${nombre} no puede llevar HTML: escribí texto plano`,
      );
    }
  }
}
