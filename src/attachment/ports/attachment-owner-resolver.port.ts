import { AttachmentOwnerType } from '../entities/attachment.entity';

/**
 * Lo que implementa cada módulo dueño de adjuntos (empleados, cargas de
 * combustible, multas...) y registra en `AttachmentOwnerRegistry`. Así
 * `attachment` no depende de ningún módulo de negocio (sin ciclos).
 */
export interface AttachmentOwnerResolver {
  readonly ownerType: AttachmentOwnerType;

  /** Lanza 404 si el dueño no existe o es de otra distribuidora. */
  assertOwner(ownerId: string, distributorId: string): Promise<void>;

  /**
   * ¿El dueño es "propio" de este usuario (la carga que hizo el chofer, su
   * rendición)? Sólo lo implementan los tipos que un chofer puede tocar; sin
   * este método, un chofer no accede a ese tipo.
   */
  isOwnedByUser?(
    ownerId: string,
    userId: string,
    distributorId: string,
  ): Promise<boolean>;
}
