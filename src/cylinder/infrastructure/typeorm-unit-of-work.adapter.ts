import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Transaccion, UnitOfWorkPort } from '../domain/ports/unit-of-work.port';
import { Cylinder } from '../entities/cylinder.entity';

/**
 * La `Transaccion` del dominio es, de este lado, el `EntityManager` de TypeORM
 * que la lleva. Los adaptadores de persistencia la abren con esta función.
 */
export function managerDe(tx: Transaccion): EntityManager {
  return tx as EntityManager;
}

/** Adaptador de la unidad de trabajo: una transacción de TypeORM. */
@Injectable()
export class TypeormUnitOfWorkAdapter extends UnitOfWorkPort {
  constructor(
    @InjectRepository(Cylinder)
    private readonly cylinders: Repository<Cylinder>,
  ) {
    super();
  }

  enTransaccion<T>(trabajo: (tx: Transaccion) => Promise<T>): Promise<T> {
    return this.cylinders.manager.transaction((manager) => trabajo(manager));
  }
}
