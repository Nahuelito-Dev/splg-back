import { Raw } from 'typeorm';

/** El correo se guarda en minúsculas: "Ana@X.com" y "ana@x.com" son el mismo. */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Condición de TypeORM que compara el correo sin distinguir mayúsculas, también
 * contra los que quedaron guardados con ellas. Usa `LOWER` y no `ILIKE`: en un
 * correo, `_` es un carácter válido y en un patrón de `ILIKE` es un comodín.
 */
export function emailIgualA(email: string) {
  return Raw((alias) => `LOWER(${alias}) = :email`, {
    email: normalizarEmail(email),
  });
}
