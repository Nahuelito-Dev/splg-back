import { ContextoDeTraza } from '../traza/contexto-de-traza';

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
    /** `null`: aviso de la plataforma (bandeja y sala `platform` del administrador general). */
    readonly distributorId: string | null,
    /** Tipo de aviso, ej.: `fleet_document_due`, `insurance_installment_due`. */
    readonly kind: string,
    readonly title: string,
    /** Texto plano: el correo lo escapa y lo arma como HTML. */
    readonly body: string,
    readonly link: DestinoDelAviso | null,
    readonly email: boolean,
    readonly dedupeKey: string,
    /**
     * La traza de quien pidió el aviso. Se captura al crear el evento: el
     * listener corre en otro contexto (`EventEmitter2` asincrónico) y ahí la
     * traza ya no es la de quien lo emitió.
     */
    readonly traceId: string | null = ContextoDeTraza.traceIdActual(),
    /**
     * Sólo para esa persona del personal de la empresa (una mención en una
     * nota interna del chat): los demás admins no lo ven. `null`: para todos.
     * Un aviso para una persona no va por correo.
     */
    readonly recipientUserId: string | null = null,
  ) {}
}
