import { ConflictException } from '@nestjs/common';

export type ValoresDelDueno = Record<string, string | null>;

/** Importe con dos decimales, como lo guarda la propuesta de una lectura. */
export const dinero = (v: number | string | null): string | null =>
  v === null ? null : Number(v).toFixed(2);

/** ¿El importe leído coincide con el esperado, dentro de la tolerancia en porcentaje? */
export const esImporteIgual = (
  esperado: string | null,
  leido: string | null,
  tolerancia: number,
): boolean => {
  if (!esperado?.trim() || !leido?.trim()) return false;
  const e = Number(esperado);
  const l = Number(leido);
  return (
    Number.isFinite(e) &&
    Number.isFinite(l) &&
    (e === 0 ? l === 0 : (Math.abs(l - e) / Math.abs(e)) * 100 <= tolerancia)
  );
};

/**
 * Compara lo que la propuesta tomó como esperado con el valor actual del
 * dueño, leído bajo candado. Una clave que la propuesta no registró no se
 * compara. Si algo cambió, 409: la decisión era sobre otros datos.
 */
export function assertDuenoSinCambios(
  esperados: ValoresDelDueno,
  actuales: ValoresDelDueno,
): void {
  for (const [campo, actual] of Object.entries(actuales)) {
    if (!Object.hasOwn(esperados, campo)) continue;
    if ((esperados[campo] ?? null) !== (actual ?? null)) {
      throw new ConflictException(
        'Los datos cambiaron desde que se armó la propuesta: volvé a abrirla',
      );
    }
  }
}
