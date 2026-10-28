/**
 * Pedido de aviso a los administradores de una distribuidora. Cualquier módulo
 * lo emite con `EventEmitter2` y no sabe cómo se entrega: el módulo de
 * notificaciones del admin lo guarda en la bandeja del panel, lo empuja por el
 * socket y, si `email` es verdadero, manda además el correo.
 *
 * `dedupeKey` identifica el aviso dentro de la distribuidora: si ya existe uno
 * con la misma clave no se repite (ej.: `insurance-installment:<id>:5d`).
 */
export const EVENTO_NOTIFICAR_ADMIN = 'admin.notificar';

/** A qué pantalla del panel lleva el aviso al hacerle click. */
export interface DestinoDelAviso {
  /** Tipo de entidad, ej.: `car`, `insurance-installment`, `traffic-fine`, `fleet-task`. */
  entity: string;
  id: string;
}

export class NotificarAdminEvent {
  constructor(
    readonly distributorId: string,
    /** Tipo de aviso, ej.: `fleet_document_due`, `insurance_installment_due`. */
    readonly kind: string,
    readonly title: string,
    /** Texto plano: el correo lo escapa y lo arma como HTML. */
    readonly body: string,
    readonly link: DestinoDelAviso | null,
    readonly email: boolean,
    readonly dedupeKey: string,
  ) {}
}
