/**
 * Una transacción en curso. Es opaca para el dominio y la aplicación: sólo la
 * pasan de mano en mano; qué hay adentro lo sabe el adaptador de persistencia.
 */
export type Transaccion = object;

/**
 * PUERTO de la unidad de trabajo: todo lo que se haga con la `Transaccion`
 * que entrega se confirma junto o no se confirma.
 */
export abstract class UnitOfWorkPort {
  abstract enTransaccion<T>(
    trabajo: (tx: Transaccion) => Promise<T>,
  ): Promise<T>;
}
