/** Normaliza un UUID a minúsculas: Postgres los devuelve así y se comparan como texto. */
export const enMinusculas = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;
