/** PUERTO de choferes visto desde envases: qué chofer es el usuario que actúa. */
export abstract class DriverPort {
  /** El `delivery_id` del usuario, o `null` si no tiene perfil de chofer. */
  abstract deliveryIdDe(userId: string): Promise<string | null>;
}
