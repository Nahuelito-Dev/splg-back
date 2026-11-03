import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  crearFuncionDelLote,
  crearTriggerDelLote,
  quitarTriggerDelLote,
} from './sql/transicion-lote-de-recorrido';

/**
 * Hoja de ruta (M4, modalidad `planned`): el lote de recorrido gana una
 * modalidad (`kind`, las filas de hoy quedan `offer`), la planificación del día
 * (`route_plan`), vehículo, depósito, carga del camión, totales y versión
 * optimista, y la parada gana ETA prometida, franja avisada, posición fija y el
 * motivo de salida. Suma también las capacidades del vehículo en garrafas
 * (`car.max_cylinders`) y el punto del depósito (`warehouse.location`).
 *
 * - `UQ_route_batch_stop_secuencia` pasa a ser parcial (`WHERE "active"`): con
 *   hojas que se reordenan y paradas que salen y vuelven a entrar, una parada
 *   inactiva no puede bloquear un orden. Los lotes de hoy no cambian: sus
 *   paradas activas ya eran únicas.
 * - El trigger de transición de estado (`TRG_route_batch_transicion_de_estado`)
 *   copia las dos máquinas de `route-sheet.machine.ts` (una por modalidad) y
 *   rechaza cambiar `kind`; su definición está en
 *   `sql/transicion-lote-de-recorrido.ts`, aparte de la copia congelada que
 *   usaron las migraciones anteriores.
 * - `CHK_route_plan_propuesta` pide propuesta sólo para `proposed`: un día se
 *   puede armar a mano y cerrar sin que corra nunca la propuesta.
 *
 * Los valores de enum nuevos los agrega `HojaDeRutaEnums`, que corre antes.
 */
export class HojaDeRuta1794800000001 implements MigrationInterface {
  name = 'HojaDeRuta1794800000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."route_plan_status_enum" AS ENUM('open', 'proposed', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "route_plan" ("plan_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "plan_date" date NOT NULL, "status" "public"."route_plan_status_enum" NOT NULL DEFAULT 'open', "cutoff_at" TIMESTAMP WITH TIME ZONE NOT NULL, "proposed_at" TIMESTAMP WITH TIME ZONE, "proposal_summary" jsonb, "closed_at" TIMESTAMP WITH TIME ZONE, "closed_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_route_plan_dia" UNIQUE ("distributor_id", "plan_date"), CONSTRAINT "CHK_route_plan_cierre" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)), CONSTRAINT "CHK_route_plan_propuesta" CHECK ("status" IN ('open', 'closed') OR "proposed_at" IS NOT NULL), CONSTRAINT "PK_29e16014da483a85349785d1add" PRIMARY KEY ("plan_id"))`,
    );
    await queryRunner.query(`ALTER TABLE "car" ADD "max_cylinders" integer`);
    await queryRunner.query(
      `ALTER TABLE "warehouse" ADD "location" geometry(Point,4326)`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."route_batch_kind_enum" AS ENUM('offer', 'planned')`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "kind" "public"."route_batch_kind_enum" NOT NULL DEFAULT 'offer'`,
    );
    await queryRunner.query(`ALTER TABLE "route_batch" ADD "plan_date" date`);
    await queryRunner.query(`ALTER TABLE "route_batch" ADD "number" integer`);
    await queryRunner.query(`ALTER TABLE "route_batch" ADD "car_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "origin_warehouse_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "truck_load_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "planned_start_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "total_distance_km" numeric(8,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "total_duration_min" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "total_units" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "peak_units" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "optimization_method" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "matrix_source" character varying(12)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "proposed_by" character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "confirmed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "confirmed_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "started_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "planned_eta_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "leg_duration_min" numeric(6,1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "sequence_locked" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "notified_window_start" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "notified_window_end" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "notified_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."route_batch_stop_removed_reason_enum" AS ENUM('cancelled', 'moved', 'reassigned', 'failed_delivery', 'admin', 'unavailable')`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "removed_reason" "public"."route_batch_stop_removed_reason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "removed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_route_batch_plan" ON "route_batch" ("distributor_id", "plan_date", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_numero" ON "route_batch" ("distributor_id", "number") WHERE "number" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_hoja_vehiculo_dia" ON "route_batch" ("car_id", "plan_date") WHERE "kind" = 'planned' AND "status" IN ('confirmed', 'assigned')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_hoja_chofer_dia" ON "route_batch" ("delivery_id", "plan_date") WHERE "kind" = 'planned' AND "status" IN ('confirmed', 'assigned')`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD CONSTRAINT "CHK_car_max_cylinders" CHECK ("max_cylinders" IS NULL OR "max_cylinders" > 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_propuesta_por" CHECK ("proposed_by" IS NULL OR "proposed_by" IN ('system', 'admin'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_matriz" CHECK ("matrix_source" IS NULL OR "matrix_source" IN ('osrm', 'google', 'haversine'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_metodo" CHECK ("optimization_method" IS NULL OR "optimization_method" IN ('nn_2opt', 'manual'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_hoja_numero" CHECK ("number" IS NULL OR ("kind" = 'planned' AND "number" >= 1))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_totales" CHECK (("total_distance_km" IS NULL OR "total_distance_km" >= 0) AND ("total_duration_min" IS NULL OR "total_duration_min" >= 0))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_pico" CHECK ("peak_units" IS NULL OR "peak_units" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_unidades" CHECK ("total_units" IS NULL OR "total_units" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_hoja_iniciada" CHECK ("status" <> 'assigned' OR "kind" <> 'planned' OR "started_at" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_hoja_confirmada" CHECK ("kind" <> 'planned' OR "status" IN ('draft', 'dissolved') OR ("delivery_id" IS NOT NULL AND "car_id" IS NOT NULL AND "confirmed_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_estados_hoja" CHECK ("kind" = 'offer' OR "status" NOT IN ('forming', 'offered'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_estados_oferta" CHECK ("kind" = 'planned' OR "status" NOT IN ('draft', 'confirmed'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_hoja_fecha" CHECK (("kind" = 'planned') = ("plan_date" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "CHK_route_batch_stop_tramo_min" CHECK ("leg_duration_min" IS NULL OR "leg_duration_min" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "CHK_route_batch_stop_salida" CHECK (("removed_reason" IS NULL) = ("removed_at" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "CHK_route_batch_stop_ventana" CHECK (("notified_window_start" IS NULL) = ("notified_window_end" IS NULL) AND ("notified_window_start" IS NULL OR "notified_window_start" < "notified_window_end"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_hoja_de_ruta" CHECK ("module"::text <> 'route_planning' OR (("params" -> 'enabled' IS NULL OR (jsonb_typeof("params" -> 'enabled') = 'number' AND ("params" ->> 'enabled')::numeric BETWEEN 0 AND 1 AND ("params" ->> 'enabled')::numeric = trunc(("params" ->> 'enabled')::numeric))) AND ("params" -> 'cutoffHour' IS NULL OR (jsonb_typeof("params" -> 'cutoffHour') = 'number' AND ("params" ->> 'cutoffHour')::numeric BETWEEN 0 AND 23 AND ("params" ->> 'cutoffHour')::numeric = trunc(("params" ->> 'cutoffHour')::numeric))) AND ("params" -> 'cutoffMinute' IS NULL OR (jsonb_typeof("params" -> 'cutoffMinute') = 'number' AND ("params" ->> 'cutoffMinute')::numeric BETWEEN 0 AND 59 AND ("params" ->> 'cutoffMinute')::numeric = trunc(("params" ->> 'cutoffMinute')::numeric))) AND ("params" -> 'autoPropose' IS NULL OR (jsonb_typeof("params" -> 'autoPropose') = 'number' AND ("params" ->> 'autoPropose')::numeric BETWEEN 0 AND 1 AND ("params" ->> 'autoPropose')::numeric = trunc(("params" ->> 'autoPropose')::numeric))) AND ("params" -> 'maxStopsPerSheet' IS NULL OR (jsonb_typeof("params" -> 'maxStopsPerSheet') = 'number' AND ("params" ->> 'maxStopsPerSheet')::numeric BETWEEN 2 AND 40 AND ("params" ->> 'maxStopsPerSheet')::numeric = trunc(("params" ->> 'maxStopsPerSheet')::numeric))) AND ("params" -> 'serviceMinutes' IS NULL OR (jsonb_typeof("params" -> 'serviceMinutes') = 'number' AND ("params" ->> 'serviceMinutes')::numeric BETWEEN 1 AND 60 AND ("params" ->> 'serviceMinutes')::numeric = trunc(("params" ->> 'serviceMinutes')::numeric))) AND ("params" -> 'trafficFactor' IS NULL OR (jsonb_typeof("params" -> 'trafficFactor') = 'number' AND ("params" ->> 'trafficFactor')::numeric BETWEEN 1 AND 3)) AND ("params" -> 'etaWindowMinutes' IS NULL OR (jsonb_typeof("params" -> 'etaWindowMinutes') = 'number' AND ("params" ->> 'etaWindowMinutes')::numeric BETWEEN 10 AND 120 AND ("params" ->> 'etaWindowMinutes')::numeric = trunc(("params" ->> 'etaWindowMinutes')::numeric))) AND ("params" -> 'etaRecalcMinSeconds' IS NULL OR (jsonb_typeof("params" -> 'etaRecalcMinSeconds') = 'number' AND ("params" ->> 'etaRecalcMinSeconds')::numeric BETWEEN 30 AND 900 AND ("params" ->> 'etaRecalcMinSeconds')::numeric = trunc(("params" ->> 'etaRecalcMinSeconds')::numeric))) AND ("params" -> 'etaRecalcMinMeters' IS NULL OR (jsonb_typeof("params" -> 'etaRecalcMinMeters') = 'number' AND ("params" ->> 'etaRecalcMinMeters')::numeric BETWEEN 50 AND 5000 AND ("params" ->> 'etaRecalcMinMeters')::numeric = trunc(("params" ->> 'etaRecalcMinMeters')::numeric))) AND ("params" -> 'etaNotifyShiftMinutes' IS NULL OR (jsonb_typeof("params" -> 'etaNotifyShiftMinutes') = 'number' AND ("params" ->> 'etaNotifyShiftMinutes')::numeric BETWEEN 5 AND 120 AND ("params" ->> 'etaNotifyShiftMinutes')::numeric = trunc(("params" ->> 'etaNotifyShiftMinutes')::numeric))) AND ("params" -> 'lateOrderPolicy' IS NULL OR (jsonb_typeof("params" -> 'lateOrderPolicy') = 'number' AND ("params" ->> 'lateOrderPolicy')::numeric BETWEEN 0 AND 1 AND ("params" ->> 'lateOrderPolicy')::numeric = trunc(("params" ->> 'lateOrderPolicy')::numeric))) AND ("params" -> 'notStartedAlertMinutes' IS NULL OR (jsonb_typeof("params" -> 'notStartedAlertMinutes') = 'number' AND ("params" ->> 'notStartedAlertMinutes')::numeric BETWEEN 0 AND 240 AND ("params" ->> 'notStartedAlertMinutes')::numeric = trunc(("params" ->> 'notStartedAlertMinutes')::numeric)))))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_plan" ADD CONSTRAINT "FK_ca35640cb25b1426c46d5e3aaca" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_plan" ADD CONSTRAINT "FK_278a676271ca57228d8c7632763" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_780eac09fae50ba389e7052798b" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_03dc366d845392f6b235793f648" FOREIGN KEY ("origin_warehouse_id") REFERENCES "warehouse"("warehouse_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_a3c4e5545db266b639022a02e64" FOREIGN KEY ("truck_load_id") REFERENCES "truck_load"("load_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_d8e9b5466e087e4e5d68b5d8e4e" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_route_batch_truck_load_distribuidora" FOREIGN KEY ("truck_load_id", "distributor_id") REFERENCES "truck_load"("load_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_route_batch_origin_warehouse_distribuidora" FOREIGN KEY ("origin_warehouse_id", "distributor_id") REFERENCES "warehouse"("warehouse_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_route_batch_car_distribuidora" FOREIGN KEY ("car_id", "distributor_id") REFERENCES "car"("car_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_route_batch_plan_dia" FOREIGN KEY ("distributor_id", "plan_date") REFERENCES "route_plan"("distributor_id","plan_date") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_route_batch_stop_secuencia"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_stop_secuencia" ON "route_batch_stop" ("batch_id", "sequence") WHERE "active"`,
    );
    await queryRunner.query(crearFuncionDelLote());
    await queryRunner.query(crearTriggerDelLote());
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Volver atrás borraría `kind`, `plan_date` y `route_plan`: una hoja de ruta
    // quedaría convertida en un lote de oferta sin fecha ni vehículo, y las
    // planificaciones de los días (cierre, propuesta) se perderían. Con hojas o
    // planificaciones cargadas no se revierte; hay que cerrarlas o migrar sus
    // datos antes.
    await queryRunner.query(
      `DO $$ DECLARE hojas integer; planes integer; BEGIN
         SELECT count(*) INTO hojas FROM "route_batch" WHERE "kind" = 'planned';
         IF hojas > 0 THEN
           RAISE EXCEPTION 'No se puede revertir HojaDeRuta: hay % hojas de ruta (route_batch con kind planned) que perderían su modalidad, fecha y vehículo', hojas;
         END IF;
         SELECT count(*) INTO planes FROM "route_plan";
         IF planes > 0 THEN
           RAISE EXCEPTION 'No se puede revertir HojaDeRuta: hay % planificaciones de día (route_plan) que se perderían', planes;
         END IF;
       END $$`,
    );
    for (const sql of quitarTriggerDelLote()) {
      await queryRunner.query(sql);
    }
    // Sin el parcial, las paradas inactivas pueden repetir orden con las vivas:
    // se renumeran (vivas primero, en su orden) sólo los lotes que tienen una
    // secuencia repetida, antes de volver al único total.
    await queryRunner.query(
      `DROP INDEX "public"."UQ_route_batch_stop_secuencia"`,
    );
    await queryRunner.query(
      `UPDATE "route_batch_stop" s SET "sequence" = r.nueva FROM (SELECT "stop_id", row_number() OVER (PARTITION BY "batch_id" ORDER BY "active" DESC, "sequence", "stop_id") AS nueva FROM "route_batch_stop" WHERE "batch_id" IN (SELECT "batch_id" FROM "route_batch_stop" GROUP BY "batch_id", "sequence" HAVING count(*) > 1)) r WHERE s."stop_id" = r."stop_id" AND s."sequence" <> r.nueva`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_stop_secuencia" ON "route_batch_stop" ("batch_id", "sequence")`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_route_batch_plan_dia"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_route_batch_car_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_route_batch_origin_warehouse_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_route_batch_truck_load_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_d8e9b5466e087e4e5d68b5d8e4e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_a3c4e5545db266b639022a02e64"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_03dc366d845392f6b235793f648"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_780eac09fae50ba389e7052798b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_plan" DROP CONSTRAINT "FK_278a676271ca57228d8c7632763"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_plan" DROP CONSTRAINT "FK_ca35640cb25b1426c46d5e3aaca"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_hoja_de_ruta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "CHK_route_batch_stop_ventana"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "CHK_route_batch_stop_salida"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "CHK_route_batch_stop_tramo_min"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_hoja_fecha"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_estados_oferta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_estados_hoja"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_hoja_confirmada"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_hoja_iniciada"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_unidades"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_pico"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_totales"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_hoja_numero"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_metodo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_matriz"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_propuesta_por"`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" DROP CONSTRAINT "CHK_car_max_cylinders"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_route_batch_hoja_chofer_dia"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_route_batch_hoja_vehiculo_dia"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_route_batch_numero"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_route_batch_plan"`);
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "removed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "removed_reason"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."route_batch_stop_removed_reason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "notified_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "notified_window_end"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "notified_window_start"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "sequence_locked"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "leg_duration_min"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "planned_eta_at"`,
    );
    await queryRunner.query(`ALTER TABLE "route_batch" DROP COLUMN "version"`);
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "confirmed_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "confirmed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "edited_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "proposed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "matrix_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "optimization_method"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "peak_units"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "total_units"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "total_duration_min"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "total_distance_km"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "planned_start_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "truck_load_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "origin_warehouse_id"`,
    );
    await queryRunner.query(`ALTER TABLE "route_batch" DROP COLUMN "car_id"`);
    await queryRunner.query(`ALTER TABLE "route_batch" DROP COLUMN "number"`);
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "plan_date"`,
    );
    await queryRunner.query(`ALTER TABLE "route_batch" DROP COLUMN "kind"`);
    await queryRunner.query(`DROP TYPE "public"."route_batch_kind_enum"`);
    await queryRunner.query(`ALTER TABLE "warehouse" DROP COLUMN "location"`);
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "max_cylinders"`);
    await queryRunner.query(`DROP TABLE "route_plan"`);
    await queryRunner.query(`DROP TYPE "public"."route_plan_status_enum"`);
  }
}
