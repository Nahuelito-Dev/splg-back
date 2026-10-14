/** Resumen de las calificaciones que recibió un chofer. */
export interface ResumenDeCalificaciones {
  /** Promedio de estrellas (2 decimales); 0 si todavía no tiene. */
  average: number;
  count: number;
}

/**
 * PUERTO de lectura de la calificación de un chofer, para mostrarla en el
 * pedido. `rating` depende de `order`, así que el pedido no puede importar su
 * servicio: lo implementa un adaptador de lectura en infraestructura.
 */
export abstract class DriverRatingPort {
  abstract resumen(driverUserId: string): Promise<ResumenDeCalificaciones>;
}
