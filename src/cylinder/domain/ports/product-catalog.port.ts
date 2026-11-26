/** PUERTO del catálogo de productos visto desde envases. */
export abstract class ProductCatalogPort {
  /** El producto tiene que existir y ser de la distribuidora; si no, rechaza (404). */
  abstract asegurarProducto(
    gasCylinderId: string,
    distributorId: string,
  ): Promise<void>;
}
