import { Logger } from '@nestjs/common';

/**
 * Lee una variable de entorno numérica (ms, tamaños) que tiene que ser un
 * entero positivo. Si no está definida se usa el valor por defecto sin ruido;
 * si viene vacía o inválida (`''`, `abc`, `0`, `-5`, `1.5`) también se usa el
 * valor por defecto, pero con un warn: `Number('')` da 0 y `Number('abc')` da
 * NaN, y en un timeout de Postgres 0 significa "sin límite".
 */
export function enteroPositivoDeEnv(
  nombre: string,
  valor: string | number | null | undefined,
  porDefecto: number,
  logger: Pick<Logger, 'warn'> = new Logger('EnvConfig'),
): number {
  if (valor === undefined || valor === null) return porDefecto;
  const texto = String(valor).trim();
  if (/^[1-9]\d*$/.test(texto)) {
    const n = Number(texto);
    if (Number.isSafeInteger(n)) return n;
  }
  logger.warn(
    `${nombre}="${texto}" no es un entero positivo: se usa el valor por defecto (${porDefecto})`,
  );
  return porDefecto;
}
