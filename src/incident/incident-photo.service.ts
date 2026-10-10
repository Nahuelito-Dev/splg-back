import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Incident, IncidentStatus } from './entities/incident.entity';
import { IncidentService } from './incident.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
  VerificarFila,
} from '../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: Incident,
  idProp: 'incidentId',
  keyProp: 'photoKey',
};

/**
 * Foto de la incidencia: la sube quien la reportó (el chofer) o un admin de
 * la distribuidora. `photo_url` (URL externa de antes) queda como respaldo.
 */
@Injectable()
export class IncidentPhotoService {
  constructor(
    private readonly incidents: IncidentService,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa la URL firmada en una o varias incidencias. */
  firmar(incidencias: Incident | readonly Incident[]): Promise<void> {
    return this.fotos.firmar(incidencias, (i) => i.photoKey);
  }

  /** El tenant da 404; un chofer que no la reportó, 403. */
  private async cargar(
    id: string,
    user: AuthenticatedUser,
    distributorId: string | null,
  ): Promise<Incident> {
    const incident = await this.incidents.findOne(id, distributorId);
    if (
      user.role === RoleType.DELIVERY &&
      incident.reportedBy !== user.user_id
    ) {
      throw new ForbiddenException('Sólo ves las incidencias que reportaste');
    }
    return incident;
  }

  /** La evidencia de una incidencia cerrada (resuelta o descartada) no se toca. */
  private soloAbierta(estado: unknown): void {
    if (estado !== IncidentStatus.OPEN) {
      throw new ConflictException(
        'Sólo se cambia la foto de una incidencia abierta',
      );
    }
  }

  /** Lo mismo, con la fila bloqueada: una resolución en el medio gana. */
  private readonly abiertaEnLock: VerificarFila = (fila) =>
    this.soloAbierta(fila.status);

  async subir(
    id: string,
    user: AuthenticatedUser,
    distributorId: string | null,
    file: Express.Multer.File | undefined,
  ): Promise<Incident> {
    const incident = await this.cargar(id, user, distributorId);
    this.soloAbierta(incident.status);
    await this.fotos.guardar(
      DESTINO,
      id,
      file,
      `incidents/${incident.distributorId}/${id}`,
      this.abiertaEnLock,
    );
    return this.recargar(id, distributorId);
  }

  async quitar(
    id: string,
    user: AuthenticatedUser,
    distributorId: string | null,
  ): Promise<Incident> {
    const incident = await this.cargar(id, user, distributorId);
    this.soloAbierta(incident.status);
    await this.fotos.quitar(DESTINO, id, this.abiertaEnLock);
    return this.recargar(id, distributorId);
  }

  async enlace(
    id: string,
    user: AuthenticatedUser,
    distributorId: string | null,
  ): Promise<EnlaceDeFoto> {
    const incident = await this.cargar(id, user, distributorId);
    return this.fotos.enlace(incident.photoKey, incident.photoUrl);
  }

  private async recargar(
    id: string,
    distributorId: string | null,
  ): Promise<Incident> {
    const incident = await this.incidents.findOne(id, distributorId);
    await this.firmar(incident);
    return incident;
  }
}
