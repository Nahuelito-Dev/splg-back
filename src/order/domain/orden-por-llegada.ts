/**
 * Ordena a los candidatos de un paso de radio por lo que tardan en llegar:
 * primero los que tienen minutos estimados, de menor a mayor (a igualdad queda
 * el orden del radar); después, los que no tienen estimación, en el orden del
 * radar. Función pura: no toca la lista que recibe.
 */
export function ordenarPorLlegada(
  enOrdenDeRadar: readonly string[],
  minutosPorChofer: ReadonlyMap<string, number>,
): string[] {
  const medidos = enOrdenDeRadar
    .map((id, posicion) => ({
      id,
      posicion,
      minutos: minutosPorChofer.get(id),
    }))
    .filter(
      (c): c is { id: string; posicion: number; minutos: number } =>
        c.minutos !== undefined && Number.isFinite(c.minutos),
    )
    .sort((a, b) => a.minutos - b.minutos || a.posicion - b.posicion)
    .map((c) => c.id);
  const medidosSet = new Set(medidos);
  return [...medidos, ...enOrdenDeRadar.filter((id) => !medidosSet.has(id))];
}
