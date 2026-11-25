import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorCode } from '../../common/errors/error-message';
import { Envase, NuevoEnvase } from '../domain/envase';
import { EnvaseEnConflictoError } from '../domain/errors/cylinder-rule.errors';
import { CylinderRepositoryPort } from '../domain/ports/cylinder.repository.port';
import { Transaccion } from '../domain/ports/unit-of-work.port';
import { Cylinder, CylinderState } from '../entities/cylinder.entity';
import { managerDe } from './typeorm-unit-of-work.adapter';

/** Violación de índice único de Postgres: acá, el serial repetido en la distribuidora. */
const UNICO_VIOLADO = '23505';

/**
 * Adaptador TypeORM del repositorio de envases. La entidad `Cylinder` es el
 * detalle de persistencia: de la fila se arma el agregado `Envase` y, al
 * guardar, los cambios del agregado vuelven a la misma fila.
 */
@Injectable()
export class CylinderTypeormRepository extends CylinderRepositoryPort {
  /** La fila de la que salió cada agregado, para guardarlo sobre ella. */
  private readonly filas = new WeakMap<Envase, Cylinder>();

  constructor(
    @InjectRepository(Cylinder)
    private readonly cylinders: Repository<Cylinder>,
  ) {
    super();
  }

  async crear(nuevo: NuevoEnvase): Promise<Envase> {
    const fila = this.cylinders.create({
      distributorId: nuevo.distributorId,
      serial: nuevo.serial,
      gasCylinderId: nuevo.gasCylinderId,
      deposit: nuevo.deposit,
      state: nuevo.state,
    });
    return this.aDominio(await this.salvar(this.cylinders, fila));
  }

  async verPedidoActual(
    tx: Transaccion,
    cylinderId: string,
    distributorId: string,
  ): Promise<{ currentOrderId: string | null } | null> {
    const visto = await managerDe(tx)
      .getRepository(Cylinder)
      .findOne({
        where: { cylinderId, distributorId },
        select: { cylinderId: true, currentOrderId: true },
      });
    return visto ? { currentOrderId: visto.currentOrderId } : null;
  }

  async bloquear(
    tx: Transaccion,
    cylinderId: string,
    distributorId: string,
  ): Promise<Envase | null> {
    const fila = await managerDe(tx)
      .createQueryBuilder(Cylinder, 'cylinder')
      .setLock('pessimistic_write')
      .where('cylinder.cylinderId = :id', { id: cylinderId })
      .andWhere('cylinder.distributorId = :distributorId', { distributorId })
      .getOne();
    return fila ? this.aDominio(fila) : null;
  }

  async bloquearPorSerial(
    tx: Transaccion,
    serials: string[],
    distributorId: string,
  ): Promise<Envase[]> {
    // La búsqueda compara la forma canónica en SQL (`upper(btrim(serial))`, la
    // del índice `UQ_cylinder_serial_normalizado`): un envase guardado como
    // `sn-1 ` se encuentra con `SN-1` aunque la fila no se haya normalizado.
    // Orden fijo por serial: dos asignaciones cruzadas no se bloquean entre sí.
    const filas = await managerDe(tx)
      .createQueryBuilder(Cylinder, 'cylinder')
      .setLock('pessimistic_write')
      .where(
        'upper(btrim(cylinder.serial)) IN (SELECT upper(btrim(s)) FROM unnest(CAST(:serials AS text[])) AS s)',
        { serials: serials },
      )
      .andWhere('cylinder.distributorId = :distributorId', { distributorId })
      .orderBy('upper(btrim(cylinder.serial))', 'ASC')
      .addOrderBy('cylinder.cylinderId', 'ASC')
      .getMany();
    return filas.map((fila) => this.aDominio(fila));
  }

  async bloquearDespachadosDelPedido(
    tx: Transaccion,
    orderId: string,
    distributorId?: string | null,
  ): Promise<Envase[]> {
    const consulta = managerDe(tx)
      .createQueryBuilder(Cylinder, 'cylinder')
      .setLock('pessimistic_write')
      .where('cylinder.currentOrderId = :orderId', { orderId })
      .andWhere('cylinder.state = :state', { state: CylinderState.DISPATCHED });
    if (distributorId) {
      consulta.andWhere('cylinder.distributorId = :distributorId', {
        distributorId,
      });
    }
    const filas = await consulta.orderBy('cylinder.serial', 'ASC').getMany();
    return filas.map((fila) => this.aDominio(fila));
  }

  async guardar(tx: Transaccion, envase: Envase): Promise<Envase> {
    const fila = this.filas.get(envase);
    if (!fila) {
      throw new Error('El envase a guardar no salió de este repositorio');
    }
    const datos = envase.snapshot();
    fila.serial = datos.serial;
    fila.gasCylinderId = datos.gasCylinderId;
    fila.state = datos.state;
    fila.currentCustomerId = datos.currentCustomerId;
    fila.currentOrderId = datos.currentOrderId;
    fila.deposit = datos.deposit;
    fila.manufacturedAt = datos.manufacturedAt;
    fila.lastInspectionAt = datos.lastInspectionAt;
    fila.expiresAt = datos.expiresAt;
    return this.aDominio(
      await this.salvar(managerDe(tx).getRepository(Cylinder), fila),
    );
  }

  private async salvar(
    repositorio: Repository<Cylinder>,
    fila: Cylinder,
  ): Promise<Cylinder> {
    try {
      return await repositorio.save(fila);
    } catch (error) {
      if (errorCode(error) === UNICO_VIOLADO) {
        throw new EnvaseEnConflictoError(
          'El serial ya existe en tu distribuidora',
        );
      }
      throw error;
    }
  }

  private aDominio(fila: Cylinder): Envase {
    const envase = Envase.rehidratar({
      cylinderId: fila.cylinderId,
      distributorId: fila.distributorId,
      serial: fila.serial,
      gasCylinderId: fila.gasCylinderId,
      state: fila.state,
      currentCustomerId: fila.currentCustomerId,
      currentOrderId: fila.currentOrderId,
      deposit: fila.deposit,
      photoKey: fila.photoKey,
      manufacturedAt: fila.manufacturedAt,
      lastInspectionAt: fila.lastInspectionAt,
      expiresAt: fila.expiresAt,
      createdAt: fila.createdAt,
      updatedAt: fila.updatedAt,
    });
    this.filas.set(envase, fila);
    return envase;
  }
}
