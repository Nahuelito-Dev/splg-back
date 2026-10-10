import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Employee } from './entities/employee.entity';
import { EmployeeService } from './employee.service';
import type { EmployeeConPuesto } from './employee.mapper';
import { User } from '../users/entities/user.entity';
import {
  DestinoDeFoto,
  EnlaceDeFoto,
  EntityPhotoService,
  VerificarFila,
} from '../s3/entity-photo.service';

const DESTINO: DestinoDeFoto = {
  entity: Employee,
  idProp: 'employeeId',
  keyProp: 'photoKey',
};

const CON_CUENTA =
  'El legajo tiene cuenta de acceso: su foto es la de perfil del usuario ' +
  '(PUT /users/:id/photo)';

/** Se corre con el legajo bloqueado: una cuenta otorgada en el medio gana. */
const SIN_CUENTA: VerificarFila = (fila) => {
  if (fila.userId) throw new ConflictException(CON_CUENTA);
};

/**
 * Foto del legajo. Sólo se sube para un empleado SIN cuenta: si tiene usuario,
 * la fuente de verdad es la foto del usuario y el legajo la muestra (así no
 * hay dos fotos que se desincronicen).
 */
@Injectable()
export class EmployeePhotoService {
  constructor(
    private readonly employees: EmployeeService,
    private readonly dataSource: DataSource,
    private readonly fotos: EntityPhotoService,
  ) {}

  /**
   * Completa la URL firmada de uno o varios legajos: la del usuario si el
   * legajo tiene cuenta, si no la propia.
   */
  async firmar(
    empleados: Employee | readonly Employee[] | null | undefined,
  ): Promise<void> {
    if (!empleados) return;
    const lista: readonly Employee[] = Array.isArray(empleados)
      ? (empleados as readonly Employee[])
      : [empleados as Employee];
    const userIds = [
      ...new Set(lista.flatMap((e) => (e.userId ? [e.userId] : []))),
    ];
    const claveDeUsuario = new Map<string, string | null>();
    if (userIds.length) {
      const usuarios = await this.dataSource.getRepository(User).find({
        where: { userId: In(userIds) },
        select: { userId: true, photoKey: true },
      });
      for (const u of usuarios) claveDeUsuario.set(u.userId, u.photoKey);
    }
    await this.fotos.firmar(lista, (e) =>
      e.userId ? (claveDeUsuario.get(e.userId) ?? null) : e.photoKey,
    );
  }

  async subir(
    id: string,
    distributorId: string,
    file: Express.Multer.File | undefined,
  ): Promise<EmployeeConPuesto> {
    const empleado = await this.employees.findOne(id, distributorId);
    if (empleado.userId) throw new ConflictException(CON_CUENTA);
    await this.fotos.guardar(
      DESTINO,
      id,
      file,
      `employees/${distributorId}/${id}`,
      SIN_CUENTA,
    );
    return this.recargar(id, distributorId);
  }

  async quitar(id: string, distributorId: string): Promise<EmployeeConPuesto> {
    const empleado = await this.employees.findOne(id, distributorId);
    if (empleado.userId) throw new ConflictException(CON_CUENTA);
    await this.fotos.quitar(DESTINO, id, SIN_CUENTA);
    return this.recargar(id, distributorId);
  }

  async enlace(id: string, distributorId: string): Promise<EnlaceDeFoto> {
    const empleado = await this.employees.findOne(id, distributorId);
    if (empleado.userId) {
      const usuario = await this.dataSource.getRepository(User).findOne({
        where: { userId: empleado.userId },
        select: { userId: true, photoKey: true },
      });
      return this.fotos.enlace(usuario?.photoKey);
    }
    return this.fotos.enlace(empleado.photoKey);
  }

  private async recargar(
    id: string,
    distributorId: string,
  ): Promise<EmployeeConPuesto> {
    const empleado = await this.employees.findOne(id, distributorId);
    await this.firmar(empleado);
    return empleado;
  }
}
