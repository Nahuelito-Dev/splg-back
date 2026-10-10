import { Injectable } from '@nestjs/common';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
} from '../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: User,
  idProp: 'userId',
  keyProp: 'photoKey',
};

/**
 * Foto de perfil del usuario (admin, chofer o cliente). Quién puede tocar la
 * de quién lo decide el controlador; acá sólo se guarda, se saca y se firma.
 * Es la única fuente de verdad: el chofer y el cliente la muestran desde `user`.
 */
@Injectable()
export class UserPhotoService {
  constructor(
    private readonly users: UsersService,
    private readonly fotos: EntityPhotoService,
  ) {}

  /** Completa la URL firmada en uno o varios usuarios (también los anidados en otras entidades). */
  firmar(usuarios: User | readonly User[] | null | undefined): Promise<void> {
    return this.fotos.firmar(usuarios, (u) => u.photoKey);
  }

  async subir(
    id: string,
    file: Express.Multer.File | undefined,
  ): Promise<User> {
    await this.users.findOne(id);
    await this.fotos.guardar(DESTINO, id, file, `users/${id}`);
    return this.recargar(id);
  }

  async quitar(id: string): Promise<User> {
    await this.users.findOne(id);
    await this.fotos.quitar(DESTINO, id);
    return this.recargar(id);
  }

  async enlace(id: string): Promise<EnlaceDeFoto> {
    const user = await this.users.findOne(id);
    return this.fotos.enlace(user.photoKey);
  }

  private async recargar(id: string): Promise<User> {
    const user = await this.users.findOne(id);
    await this.firmar(user);
    return user;
  }
}
