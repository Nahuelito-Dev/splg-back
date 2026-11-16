import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CustomerContainerService } from '../../customer-container/customer-container.service';
import { CustomerContainerMovementReason } from '../../customer-container/entities/customer-container-movement.entity';
import { ContainerChargeSettingsService } from '../../distributor/container-charge-settings.service';
import { CylinderRecoveryCase } from '../entities/cylinder-recovery-case.entity';

/** Envase con serie cubierto por los propios del cliente: `cylinderId` → cliente que lo tiene. */
export type EnvasesCubiertos = ReadonlyMap<string, string>;

/** Nota del cierre de un caso cuyo envase pasó a estar cubierto por la cuenta de envases. */
export const NOTA_CUBIERTO_POR_LA_CUENTA =
  'Cerrado sin cargo: el envase quedó cubierto por los envases propios del cliente (cuenta de envases)';

/**
 * Los envases con serie cubiertos por los propios del cliente: por cliente y
 * tipo, los `owned` de entrega más nueva (un envase con el depósito cobrado en
 * su entrega actual cuenta como propio). `$2` y `$3` acotan a un cliente y un
 * tipo (o `NULL` para toda la distribuidora `$1`).
 */
const CONSULTA_DE_CUBIERTOS = `WITH afuera AS (
           SELECT c.cylinder_id, c.current_customer_id AS customer_id, c.gas_cylinder_id,
                  c.serial, d.delivered_at,
                  EXISTS (
                    SELECT 1 FROM cylinder_recovery_case k
                     WHERE k.distributor_id = c.distributor_id
                       AND k.cylinder_id = c.cylinder_id
                       AND k.user_id = c.current_customer_id
                       AND k.status = 'deposit_charged'
                       AND d.delivered_at IS NOT NULL
                       AND k.delivered_at >= d.delivered_at - interval '1 second'
                  ) AS cobrado
             FROM cylinder c
             LEFT JOIN LATERAL (
               SELECT MAX(m."createdAt") AS delivered_at
                 FROM cylinder_movement m
                WHERE m.cylinder_id = c.cylinder_id AND m.to_state = 'with_customer'
             ) d ON true
            WHERE c.distributor_id = $1
              AND c.state = 'with_customer'
              AND c.current_customer_id IS NOT NULL
              AND c.gas_cylinder_id IS NOT NULL
              AND ($2::uuid IS NULL OR c.current_customer_id = $2::uuid)
              AND ($3::uuid IS NULL OR c.gas_cylinder_id = $3::uuid)
         ), numerados AS (
           SELECT a.cylinder_id, a.customer_id, a.cobrado,
                  COALESCE(cu.owned, 0) AS owned,
                  COUNT(*) FILTER (WHERE a.cobrado) OVER por_tipo AS cobrados,
                  ROW_NUMBER() OVER (
                    PARTITION BY a.customer_id, a.gas_cylinder_id, a.cobrado
                    ORDER BY a.delivered_at DESC NULLS LAST, a.serial DESC
                  ) AS desde_el_mas_nuevo
             FROM afuera a
             LEFT JOIN customer_container_account cu
               ON cu.distributor_id = $1
              AND cu.customer_user_id = a.customer_id
              AND cu.gas_cylinder_id = a.gas_cylinder_id
           WINDOW por_tipo AS (PARTITION BY a.customer_id, a.gas_cylinder_id)
         )
         SELECT cylinder_id AS "cylinderId", customer_id AS "customerId"
           FROM numerados
          WHERE cobrado OR desde_el_mas_nuevo <= GREATEST(0, owned - cobrados)`;

/**
 * Conciliación del recupero (M5) con la cuenta de envases del cliente (F35 E5).
 * Sólo actúa con «Cobrar envases» encendido en la distribuidora; apagado, el
 * recupero sigue como antes y la cuenta no se toca.
 *
 * Regla de fondo: por cliente y tipo, de los `N` envases con serie en su poder
 * sólo `max(0, N − propios)` son reclamables, los de entrega más antigua. Los
 * más nuevos quedan cubiertos por los propios. Un envase cuyo depósito ya se
 * cobró en esa entrega cuenta como propio (la decisión sumó uno a la cuenta).
 */
@Injectable()
export class CylinderRecoveryAccountService {
  constructor(
    @InjectRepository(CylinderRecoveryCase)
    private readonly cases: Repository<CylinderRecoveryCase>,
    private readonly cobroDeEnvases: ContainerChargeSettingsService,
    private readonly cuentas: CustomerContainerService,
  ) {}

  /** «Cobrar envases» encendido: el recupero se concilia con la cuenta. */
  concilia(distributorId: string): Promise<boolean> {
    return this.cobroDeEnvases.habilitado(distributorId);
  }

  /**
   * Los envases con serie de la distribuidora que NO son reclamables porque
   * los cubren los propios del cliente. `null` con el cobro de envases
   * apagado: no se excluye nada.
   */
  async cubiertos(distributorId: string): Promise<EnvasesCubiertos | null> {
    if (!(await this.concilia(distributorId))) return null;
    const filas: Array<{ cylinderId: string; customerId: string }> =
      await this.cases.manager.query(CONSULTA_DE_CUBIERTOS, [
        distributorId,
        null,
        null,
      ]);
    return new Map(filas.map((f) => [f.cylinderId, f.customerId]));
  }

  /**
   * El administrador cobró el depósito: el envase pasa a ser del cliente
   * (`owned + 1`, movimiento `purchased`), en la transacción de la decisión.
   * Si la cuenta falla, la decisión revierte. Sin tipo no hay cuenta que tocar.
   */
  async compraPorDeposito(
    manager: EntityManager,
    datos: {
      distributorId: string;
      customerUserId: string;
      gasCylinderId: string | null;
      serial: string;
      actorUserId: string;
    },
  ): Promise<boolean> {
    if (!datos.gasCylinderId) return false;
    if (!(await this.concilia(datos.distributorId))) return false;
    await this.cuentas.registrar(manager, {
      distributorId: datos.distributorId,
      customerUserId: datos.customerUserId,
      gasCylinderId: datos.gasCylinderId,
      quantity: 1,
      reason: CustomerContainerMovementReason.PURCHASED,
      note: `Depósito cobrado en el recupero del envase ${datos.serial}`,
      actorUserId: datos.actorUserId,
    });
    return true;
  }

  /**
   * Relee bajo lock si el envase sigue cubierto (antes de cerrar su caso por
   * la cuenta): bloquea la cuenta del cliente y el tipo (`FOR UPDATE`) y
   * recalcula la cobertura de ese cliente y tipo. Tiene que correr en la
   * transacción del cierre, con el envase ya bloqueado.
   */
  async sigueCubierto(
    manager: EntityManager,
    datos: {
      distributorId: string;
      cylinderId: string;
      customerUserId: string;
      gasCylinderId: string;
    },
  ): Promise<boolean> {
    if (!(await this.concilia(datos.distributorId))) return false;
    await manager.query(
      `SELECT owned FROM customer_container_account
        WHERE distributor_id = $1 AND customer_user_id = $2 AND gas_cylinder_id = $3
        FOR UPDATE`,
      [datos.distributorId, datos.customerUserId, datos.gasCylinderId],
    );
    const filas: Array<{ cylinderId: string; customerId: string }> =
      await manager.query(CONSULTA_DE_CUBIERTOS, [
        datos.distributorId,
        datos.customerUserId,
        datos.gasCylinderId,
      ]);
    return filas.some(
      (f) =>
        f.cylinderId === datos.cylinderId &&
        f.customerId === datos.customerUserId,
    );
  }
}
