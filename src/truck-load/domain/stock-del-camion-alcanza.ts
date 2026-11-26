/** Lo que pide un renglón del pedido: tipo de garrafa y cantidad. */
export interface RenglonPedido {
  gasCylinderId: string;
  quantity: number;
}

/**
 * Si las garrafas llenas del camión cubren cada renglón del pedido, por tipo.
 * `llenasPorTipo` es `gasCylinderId` → garrafas llenas que lleva; un tipo que no
 * figura es cero. Un pedido sin renglones siempre alcanza.
 */
export function alcanzaElStock(
  llenasPorTipo: ReadonlyMap<string, number>,
  renglones: readonly RenglonPedido[],
): boolean {
  return renglones.every(
    (r) => (llenasPorTipo.get(r.gasCylinderId) ?? 0) >= r.quantity,
  );
}
