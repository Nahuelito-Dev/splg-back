import { Injectable } from '@nestjs/common';
import { AttachmentOwnerType } from './entities/attachment.entity';
import { AttachmentOwnerResolver } from './ports/attachment-owner-resolver.port';

/**
 * Dónde cada módulo dueño registra su `AttachmentOwnerResolver` (en
 * `onModuleInit`). Nest no tiene multi-providers como tal: el registro cumple
 * ese papel y mantiene la dependencia en un solo sentido (negocio -> attachment).
 */
@Injectable()
export class AttachmentOwnerRegistry {
  private readonly resolvers = new Map<
    AttachmentOwnerType,
    AttachmentOwnerResolver
  >();

  register(resolver: AttachmentOwnerResolver): void {
    if (this.resolvers.has(resolver.ownerType)) {
      throw new Error(
        `Ya hay un resolver de adjuntos para "${resolver.ownerType}"`,
      );
    }
    this.resolvers.set(resolver.ownerType, resolver);
  }

  find(ownerType: AttachmentOwnerType): AttachmentOwnerResolver | undefined {
    return this.resolvers.get(ownerType);
  }
}
