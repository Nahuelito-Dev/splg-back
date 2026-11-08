/** Un renglón visto por su garrafa y su cantidad. */
export interface RenglonComparable {
  gasCylinderId: string;
  quantity: number;
}

/**
 * ¿Cambian los renglones de un pedido en edición? Mismas garrafas con las mismas
 * cantidades (sin importar el orden) = no cambian. La edición y su cotización usan
 * esta misma regla: si no cambian, el pedido conserva sus precios y envases.
 */
export function cambiaronLosRenglones(
  actuales: ReadonlyArray<RenglonComparable>,
  nuevos: ReadonlyArray<RenglonComparable> | undefined,
): boolean {
  if (!nuevos) return false;
  const mapa = (r: ReadonlyArray<RenglonComparable>) => {
    const m = new Map<string, number>();
    for (const i of r)
      m.set(i.gasCylinderId, (m.get(i.gasCylinderId) ?? 0) + i.quantity);
    return m;
  };
  const a = mapa(actuales);
  const n = mapa(nuevos);
  if (a.size !== n.size) return true;
  for (const [id, cantidad] of n) if (a.get(id) !== cantidad) return true;
  return false;
}
