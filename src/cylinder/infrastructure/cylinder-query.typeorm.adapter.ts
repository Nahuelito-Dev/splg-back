import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { EstadoDeVigencia } from '../domain/cylinder-vigencia';
import {
  ConsultaDeVencimientos,
  CylinderQueryPort,
  EnvaseVista,
  FiltrosDeEnvases,
  GrupoDeVencimiento,
  MovimientoVista,
  RevisionVista,
} from '../domain/ports/cylinder-query.port';
import { CylinderInspection } from '../entities/cylinder-inspection.entity';
import { CylinderMovement } from '../entities/cylinder-movement.entity';
import { Cylinder, CylinderState } from '../entities/cylinder.entity';

/** Lo que el panel muestra de cada envase: de qué producto es y quién lo tiene. */
const CON_PRODUCTO_Y_CLIENTE = ['gasCylinder', 'currentCustomer'];

/** Condición y orden de cada grupo del listado de vencimientos. */
const GRUPOS: Readonly<
  Record<
    GrupoDeVencimiento,
    { condicion: string; orden: 'expiresAt' | 'serial' }
  >
> = {
  expired: { condicion: 'cylinder.expiresAt <= :ahora', orden: 'expiresAt' },
  expiring: {
    condicion: 'cylinder.expiresAt > :ahora AND cylinder.expiresAt <= :limite',
    orden: 'expiresAt',
  },
  unverified: { condicion: 'cylinder.expiresAt IS NULL', orden: 'serial' },
};

/**
 * Adaptador TypeORM de las lecturas de envases. Las filas salen como vistas
 * (`EnvaseVista`): la entidad cumple esa forma y no se copia.
 */
@Injectable()
export class CylinderQueryTypeormAdapter extends CylinderQueryPort {
  constructor(
    @InjectRepository(Cylinder)
    private readonly cylinders: Repository<Cylinder>,
    @InjectRepository(CylinderMovement)
    private readonly movements: Repository<CylinderMovement>,
    @InjectRepository(CylinderInspection)
    private readonly inspections: Repository<CylinderInspection>,
  ) {
    super();
  }

  /**
   * Filtros (se combinan con AND):
   *  - `state`: estado físico actual.
   *  - `customerUserId`: los envases que el cliente tiene HOY en su poder
   *    (`current_customer_id`).
   *  - `orderId`: los envases que salieron en ese pedido: los que lo tienen como
   *    `current_order_id` o que registraron algún movimiento con ese `order_id`.
   *    El movimiento es append-only, así que un pedido ya entregado (o cuyo
   *    envase ya volvió vacío o se reasignó a otro pedido) sigue mostrando sus
   *    series.
   */
  async listar(
    distributorId: string | null | undefined,
    filtros: FiltrosDeEnvases,
    ahora: Date,
  ): Promise<[EnvaseVista[], number]> {
    const {
      state,
      orderId,
      customerUserId,
      gasCylinderId,
      vigencia,
      limit,
      offset,
    } = filtros;
    const qb = this.cylinders
      .createQueryBuilder('cylinder')
      .leftJoinAndSelect('cylinder.gasCylinder', 'gasCylinder')
      .leftJoinAndSelect('cylinder.currentCustomer', 'currentCustomer')
      .addSelect(
        `(SELECT MAX(ult."createdAt") FROM cylinder_movement ult ` +
          `WHERE ult.cylinder_id = cylinder.cylinder_id)`,
        'ultimo_movimiento',
      )
      .orderBy('cylinder.createdAt', 'DESC')
      .addOrderBy('cylinder.cylinderId', 'ASC');

    if (distributorId) {
      qb.andWhere('cylinder.distributorId = :distributorId', { distributorId });
    }
    if (state) qb.andWhere('cylinder.state = :state', { state });
    if (customerUserId) {
      qb.andWhere('cylinder.currentCustomerId = :customerUserId', {
        customerUserId,
      });
    }
    if (gasCylinderId) {
      qb.andWhere('cylinder.gasCylinderId = :gasCylinderId', { gasCylinderId });
    }
    if (vigencia === EstadoDeVigencia.VIGENTE) {
      qb.andWhere('cylinder.expiresAt > :ahora', { ahora });
    } else if (vigencia === EstadoDeVigencia.VENCIDO) {
      qb.andWhere('cylinder.expiresAt <= :ahora', { ahora });
    } else if (vigencia === EstadoDeVigencia.SIN_ACREDITAR) {
      qb.andWhere('cylinder.expiresAt IS NULL');
    } else if (vigencia === 'dispatchable') {
      qb.andWhere(
        '(cylinder.expiresAt IS NULL OR cylinder.expiresAt > :ahora)',
        { ahora },
      );
    }
    if (orderId) {
      qb.andWhere(
        new Brackets((b) => {
          b.where('cylinder.currentOrderId = :orderId').orWhere(
            `EXISTS (SELECT 1 FROM cylinder_movement mov ` +
              `WHERE mov.cylinder_id = cylinder.cylinder_id ` +
              `AND mov.order_id = :orderId)`,
          );
        }),
        { orderId },
      );
    }

    const total = await qb.getCount();
    // Las uniones son many-to-one: limit/offset (no take/skip) mantienen una
    // fila por envase y alineadas las filas crudas con las entidades.
    if (limit !== undefined) qb.limit(limit).offset(offset ?? 0);

    const { entities, raw } = await qb.getRawAndEntities<{
      cylinder_cylinder_id: string;
      ultimo_movimiento: Date | string | null;
    }>();
    const ultimoPorEnvase = new Map(
      raw.map((r) => [r.cylinder_cylinder_id, r.ultimo_movimiento]),
    );
    for (const cylinder of entities) {
      const fecha = ultimoPorEnvase.get(cylinder.cylinderId);
      cylinder.lastMovementAt = fecha ? new Date(fecha) : null;
    }
    return [entities, total];
  }

  buscarPorId(
    cylinderId: string,
    distributorId?: string | null,
  ): Promise<EnvaseVista | null> {
    return this.cylinders.findOne({
      where: {
        cylinderId,
        ...(distributorId ? { distributorId } : {}),
      },
      relations: CON_PRODUCTO_Y_CLIENTE,
    });
  }

  buscarPorSerial(
    serial: string,
    distributorId: string,
  ): Promise<EnvaseVista | null> {
    return this.cylinders.findOne({ where: { serial, distributorId } });
  }

  buscarConProducto(
    criterio: { cylinderId: string } | { serial: string },
    distributorId?: string | null,
  ): Promise<EnvaseVista | null> {
    return this.cylinders.findOne({
      where: {
        ...criterio,
        ...(distributorId ? { distributorId } : {}),
      },
      relations: ['gasCylinder'],
    });
  }

  historial(cylinderId: string): Promise<MovimientoVista[]> {
    return this.movements.find({
      where: { cylinderId },
      order: { createdAt: 'ASC' },
    });
  }

  revisiones(cylinderId: string): Promise<RevisionVista[]> {
    return this.inspections.find({
      where: { cylinderId },
      order: { inspectedAt: 'DESC' },
    });
  }

  vencimientos(
    grupo: GrupoDeVencimiento,
    consulta: ConsultaDeVencimientos,
  ): Promise<[EnvaseVista[], number]> {
    const { condicion, orden } = GRUPOS[grupo];
    const { ahora, limite, distributorId, limit, offset } = consulta;
    const qb = this.cylinders
      .createQueryBuilder('cylinder')
      .leftJoinAndSelect('cylinder.gasCylinder', 'gasCylinder')
      .where('cylinder.state != :retirado', {
        retirado: CylinderState.RETIRED,
      })
      .andWhere(condicion, { ahora, limite })
      .orderBy(`cylinder.${orden}`, 'ASC')
      .addOrderBy('cylinder.serial', 'ASC')
      .take(limit)
      .skip(offset);
    if (distributorId) {
      qb.andWhere('cylinder.distributorId = :distributorId', {
        distributorId,
      });
    }
    return qb.getManyAndCount();
  }
}
