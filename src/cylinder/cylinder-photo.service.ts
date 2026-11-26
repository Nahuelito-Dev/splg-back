import { ConflictException, Injectable } from '@nestjs/common';
import { Cylinder, CylinderState } from './entities/cylinder.entity';
import { CylinderService } from './cylinder.service';
import type { EnvaseVista } from './domain/ports/cylinder-query.port';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
} from '../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: Cylinder,
  idProp: 'cylinderId',
  keyProp: 'photoKey',
};

/**
 * Foto principal del envase. El tenant lo resuelve `CylinderService.findOne`
 * (404 si es de otra distribuidora); acá sólo se guarda, se saca y se firma.
 */
@Injectable()
export class CylinderPhotoService {
  constructor(
    private readonly cylinders: CylinderService,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa la URL firmada del envase y la de su producto, si lo trae. */
  async firmar(cylinders: EnvaseVista | readonly EnvaseVista[]): Promise<void> {
    const lista: readonly EnvaseVista[] = Array.isArray(cylinders)
      ? (cylinders as readonly EnvaseVista[])
      : [cylinders as EnvaseVista];
    await this.fotos.firmar(lista, (c) => c.photoKey);
    const productos = lista.flatMap((c) =>
      c.gasCylinder ? [c.gasCylinder] : [],
    );
    await this.fotos.firmar(productos, (g) => g.photoKey);
  }

  /** Sube o reemplaza la foto y devuelve el enlace vigente. */
  async subir(
    id: string,
    distributorId: string,
    file: Express.Multer.File | undefined,
  ): Promise<EnlaceDeFoto> {
    await this.editable(id, distributorId);
    await this.fotos.guardar(
      DESTINO,
      id,
      file,
      `cylinders/${distributorId}/${id}`,
    );
    return this.enlace(id, distributorId);
  }

  async quitar(id: string, distributorId: string): Promise<EnlaceDeFoto> {
    await this.editable(id, distributorId);
    await this.fotos.quitar(DESTINO, id);
    return this.enlace(id, distributorId);
  }

  /** Misma regla que editar el envase: dado de baja ya no se toca (409). */
  private async editable(id: string, distributorId: string): Promise<void> {
    const envase = await this.cylinders.findOne(id, distributorId);
    if (envase.state === CylinderState.RETIRED) {
      throw new ConflictException('El envase está dado de baja y no se edita');
    }
  }

  async enlace(id: string, distributorId: string): Promise<EnlaceDeFoto> {
    const envase = await this.cylinders.findOne(id, distributorId);
    return this.fotos.enlace(envase.photoKey);
  }
}
