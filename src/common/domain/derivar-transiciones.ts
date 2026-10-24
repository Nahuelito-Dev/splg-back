/**
 * Arma la tabla `estado → estados a los que puede pasar` a partir de una función
 * que dice, para cada estado, a cuáles lleva. Sirve para derivar la tabla que
 * copia la base (triggers de transición) de las mismas reglas que aplica el
 * dominio, en vez de mantener dos listas a mano.
 */
export function derivarTransiciones<E extends string>(
  estados: readonly E[],
  haciaDesde: (desde: E) => readonly E[],
): Readonly<Record<E, readonly E[]>> {
  const tabla = {} as Record<E, readonly E[]>;
  for (const desde of estados) tabla[desde] = haciaDesde(desde);
  return tabla;
}
