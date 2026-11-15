import { Injectable } from '@nestjs/common';
import { permisosEfectivos } from '../../common/permisos/catalogo';
import { EntityPhotoService } from '../../s3/entity-photo.service';
import { atiendeElCanal, type CanalDeLaBandeja } from '../domain/bandeja';
import {
  BandejaReadModel,
  type ResumenDeLaBandeja,
} from '../infrastructure/bandeja-read-model';
import {
  type ActorDeLaBandeja,
  BandejaAcceso,
  lectorDe,
} from './bandeja-acceso';

/** Alguien del personal a quien se le puede asignar una conversación. */
export interface PersonaParaAsignar {
  userId: string;
  fullName: string;
  /** Foto de perfil firmada; sin foto (o si no se pudo firmar), no viene. */
  photoUrl?: string;
}

/**
 * Lo que el panel necesita del equipo alrededor de la bandeja: las insignias
 * del menú y las pestañas (resumen) y a quién se le puede asignar una
 * conversación. Siempre dentro de la empresa de quien pide y de los canales
 * que atiende.
 */
@Injectable()
export class BandejaEquipoService {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly lectura: BandejaReadModel,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Las insignias: de las abiertas de los canales que atiende quien pide. */
  resumen(actor: ActorDeLaBandeja): Promise<ResumenDeLaBandeja> {
    return this.lectura.resumen(
      actor.distributorId,
      actor.canales,
      lectorDe(actor),
    );
  }

  /**
   * El personal vigente de la empresa que atiende el canal de esa
   * conversación: la misma regla que valida `assign` (de otra empresa, dado
   * de baja, bloqueado o sin el permiso del canal, no aparece). Una
   * conversación de otra empresa o de un canal que quien pide no atiende → 404.
   */
  async paraAsignar(
    actor: ActorDeLaBandeja,
    conversationId: string,
  ): Promise<PersonaParaAsignar[]> {
    const c = await this.acceso.buscar(actor, conversationId);
    const canal = c.channel as CanalDeLaBandeja;
    const equipo = await this.lectura.personalDeLaEmpresa(actor.distributorId);
    const atienden = equipo.filter((p) =>
      atiendeElCanal(
        { todos: p.todos, permisos: permisosEfectivos(p.permisos) },
        canal,
      ),
    );
    return Promise.all(
      atienden.map(async (p) => {
        const photoUrl = await this.fotos.urlDe(p.photoKey);
        return {
          userId: p.userId,
          fullName: p.fullName,
          ...(photoUrl ? { photoUrl } : {}),
        };
      }),
    );
  }
}
