import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Delivery } from '../delivery/entities/delivery.entity';
import { Employee } from '../employee/entities/employee.entity';
import { EntityPhotoService } from '../s3/entity-photo.service';
import { usuarioDeLaDistribuidora } from '../common/tenancy/pertenencia';
import { PersonPhotoDto } from './dto/people-photos.dto';

export interface FotosDePersonas {
  users: Record<string, PersonPhotoDto | null>;
  employees: Record<string, PersonPhotoDto | null>;
  deliveries: Record<string, PersonPhotoDto | null>;
}

/** Sin repetidos y en minúsculas: la base devuelve los uuid así y la respuesta se indexa con ellos. */
const normalizar = (ids: readonly string[]): string[] => [
  ...new Set(ids.map((id) => id.toLowerCase())),
];

/**
 * Firma de una vez las fotos de varias personas (usuarios, legajos y choferes). Con
 * distribuidora en contexto sólo entrega las de su gente; el resto sale `null`,
 * igual que un id inexistente o sin foto, para no revelar que existe.
 */
@Injectable()
export class PeoplePhotosService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly fotos: EntityPhotoService,
  ) {}

  async firmar(
    userIds: readonly string[],
    employeeIds: readonly string[],
    deliveryIds: readonly string[],
    distributorId: string | null,
    propioId: string,
  ): Promise<FotosDePersonas> {
    const ids = normalizar(userIds);
    const legajos = normalizar(employeeIds);
    const choferes = normalizar(deliveryIds);
    const cuentas = await this.clavesDeUsuarios(ids, distributorId, propioId);
    const claveDeLegajo = await this.clavesDeLegajos(
      legajos,
      distributorId,
      cuentas,
    );
    const claveDeChofer = await this.clavesDeChoferes(
      choferes,
      distributorId,
      cuentas,
    );
    return {
      users: await this.firmarClaves(ids, cuentas),
      employees: await this.firmarClaves(legajos, claveDeLegajo),
      deliveries: await this.firmarClaves(choferes, claveDeChofer),
    };
  }

  /** Claves de foto por usuario, sólo de los que pertenecen a la distribuidora. */
  private async clavesDeUsuarios(
    ids: readonly string[],
    distributorId: string | null,
    propioId: string,
  ): Promise<Map<string, string | null>> {
    const claves = new Map<string, string | null>();
    if (!ids.length) return claves;
    const consulta = this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .withDeleted()
      .select(['user.userId', 'user.photoKey'])
      .where('user.userId IN (:...ids)', { ids });
    if (distributorId) {
      // La cuenta propia no se acota: el super admin con «Ver como» no es de
      // la distribuidora que eligió y tiene que ver su propia foto.
      consulta.andWhere(
        `(user.userId = :propioId OR ${usuarioDeLaDistribuidora('user.userId')})`,
        { distributorId, propioId },
      );
    }
    for (const u of await consulta.getMany()) claves.set(u.userId, u.photoKey);
    return claves;
  }

  /**
   * Claves de foto por legajo de la distribuidora: la del usuario si tiene
   * cuenta (misma regla que `EmployeePhotoService`), si no la propia.
   */
  private async clavesDeLegajos(
    ids: readonly string[],
    distributorId: string | null,
    usuariosYaLeidos: ReadonlyMap<string, string | null>,
  ): Promise<Map<string, string | null>> {
    const claves = new Map<string, string | null>();
    if (!ids.length) return claves;
    const legajos = await this.dataSource.getRepository(Employee).find({
      where: { employeeId: In(ids), ...(distributorId && { distributorId }) },
      select: { employeeId: true, userId: true, photoKey: true },
      withDeleted: true,
    });
    const cuentas = await this.completarCuentas(
      legajos.flatMap((e) => (e.userId ? [e.userId] : [])),
      usuariosYaLeidos,
    );
    for (const e of legajos) {
      claves.set(
        e.employeeId,
        e.userId ? (cuentas.get(e.userId) ?? null) : e.photoKey,
      );
    }
    return claves;
  }

  /**
   * Claves de foto por chofer (`delivery_id`) de la distribuidora: la foto es
   * la de su usuario.
   */
  private async clavesDeChoferes(
    ids: readonly string[],
    distributorId: string | null,
    usuariosYaLeidos: ReadonlyMap<string, string | null>,
  ): Promise<Map<string, string | null>> {
    const claves = new Map<string, string | null>();
    if (!ids.length) return claves;
    const choferes = await this.dataSource.getRepository(Delivery).find({
      where: { deliveryId: In(ids), ...(distributorId && { distributorId }) },
      select: { deliveryId: true, userId: true },
      withDeleted: true,
    });
    const cuentas = await this.completarCuentas(
      choferes.map((d) => d.userId),
      usuariosYaLeidos,
    );
    for (const d of choferes) {
      claves.set(d.deliveryId, cuentas.get(d.userId) ?? null);
    }
    return claves;
  }

  /**
   * Suma a las claves ya leídas las de las cuentas que faltan. Quien llama ya
   * acotó por distribuidora el legajo o el chofer que las referencia: acá no
   * se vuelve a acotar el usuario.
   */
  private async completarCuentas(
    userIds: readonly string[],
    yaLeidas: ReadonlyMap<string, string | null>,
  ): Promise<Map<string, string | null>> {
    const cuentas = new Map(yaLeidas);
    const faltantes = [...new Set(userIds)].filter((id) => !cuentas.has(id));
    if (faltantes.length) {
      const usuarios = await this.dataSource.getRepository(User).find({
        where: { userId: In(faltantes) },
        select: { userId: true, photoKey: true },
        withDeleted: true,
      });
      for (const u of usuarios) cuentas.set(u.userId, u.photoKey);
    }
    return cuentas;
  }

  private async firmarClaves(
    ids: readonly string[],
    claves: ReadonlyMap<string, string | null>,
  ): Promise<Record<string, PersonPhotoDto | null>> {
    const entradas = await Promise.all(
      ids.map(async (id): Promise<[string, PersonPhotoDto | null]> => {
        const firmada = await this.fotos.firmadaDe(claves.get(id));
        return [
          id,
          firmada ? { url: firmada.url, expiresAt: firmada.expiresAt } : null,
        ];
      }),
    );
    return Object.fromEntries(entradas);
  }
}
