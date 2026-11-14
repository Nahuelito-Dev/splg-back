import { Transform } from 'class-transformer';

/** Quita los espacios de los extremos de un texto (lo demás pasa tal cual). */
export const Recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
