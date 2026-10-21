import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unicidades que hasta ahora cuidaba sólo el back (y que dos pedidos al mismo
 * tiempo podían saltearse):
 *  - correo del usuario sin distinguir mayúsculas (reemplaza el índice común
 *    `IDX_user_email_lower`);
 *  - patente única por distribuidora (antes era única en todo el sistema) y
 *    sólo entre los vehículos vigentes;
 *  - una dirección principal por usuario;
 *  - una oferta de despacho viva por (pedido, chofer) y una aceptada por pedido;
 *  - una garrafa por renglón de pedido;
 *  - nombre de franja y de zona sin repetir entre las activas de la distribuidora;
 *  - prioridad de zona única entre las zonas activas de una distribuidora;
 *  - serial de envase y tipo de garrafa sin distinguir mayúsculas ni espacios;
 *  - orden de parada único dentro de una ruta.
 */
export class UnicidadesDeLaBase1792700400000 implements MigrationInterface {
  name = 'UnicidadesDeLaBase1792700400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_user_email_lower"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_email_minusculas" ON "user" (lower("email"))`,
    );
    await queryRunner.query(`DROP INDEX "UQ_car_patente_vigente"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_car_patente_distribuidora_vigente" ON "car" ("distributor_id", "car_patent") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_address_principal" ON "user_address" ("user_id") WHERE "isDefault" AND "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_order_dispatch_offer_viva" ON "order_dispatch_offer" ("order_id", "driver_id") WHERE "status" = 'offered'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_order_dispatch_offer_aceptada" ON "order_dispatch_offer" ("order_id") WHERE "status" = 'accepted'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_order_item_pedido_producto" ON "order_item" ("order_id", "gas_cylinder_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_time_slot_nombre_activa" ON "time_slot" ("distributor_id", lower("name")) WHERE "isActive"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_coverage_zone_nombre_activa" ON "coverage_zone" ("distributor_id", lower("name")) WHERE "isActive" AND "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_coverage_zone_prioridad_activa" ON "coverage_zone" ("distributor_id", "priority") WHERE "isActive" AND "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cylinder_serial_normalizado" ON "cylinder" ("distributor_id", upper(btrim("serial")))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_gas_cylinder_tipo_normalizado" ON "gas_cylinder" ("distributor_id", lower(btrim("type")))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_stop_secuencia" ON "route_batch_stop" ("batch_id", "sequence")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // La patente vuelve a ser única en todo el sistema. Con esta tanda la misma
    // patente puede estar en dos distribuidoras: en ese caso no se puede volver
    // atrás sin decidir cuál se conserva, así que se aborta antes de tocar nada.
    const repetidas = (await queryRunner.query(
      `SELECT "car_patent", count(DISTINCT "distributor_id")::text AS distribuidoras
           FROM "car" WHERE "deletedAt" IS NULL AND "car_patent" IS NOT NULL
          GROUP BY "car_patent" HAVING count(*) > 1`,
    )) as Array<{ car_patent: string; distribuidoras: string }>;
    if (repetidas.length > 0) {
      throw new Error(
        `No se puede deshacer UnicidadesDeLaBase: ${repetidas.length} patente(s) vigentes repetidas entre distribuidoras (${repetidas
          .slice(0, 5)
          .map((r) => r.car_patent)
          .join(', ')}). Dá de baja o cambiá las repetidas y volvé a intentar.`,
      );
    }
    for (const indice of [
      'UQ_route_batch_stop_secuencia',
      'UQ_gas_cylinder_tipo_normalizado',
      'UQ_cylinder_serial_normalizado',
      'UQ_coverage_zone_prioridad_activa',
      'UQ_coverage_zone_nombre_activa',
      'UQ_time_slot_nombre_activa',
      'UQ_order_item_pedido_producto',
      'UQ_order_dispatch_offer_aceptada',
      'UQ_order_dispatch_offer_viva',
      'UQ_user_address_principal',
      'UQ_car_patente_distribuidora_vigente',
      'UQ_user_email_minusculas',
    ]) {
      await queryRunner.query(`DROP INDEX "${indice}"`);
    }
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_car_patente_vigente" ON "car" ("car_patent") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_email_lower" ON "user" (lower("email"))`,
    );
  }
}
