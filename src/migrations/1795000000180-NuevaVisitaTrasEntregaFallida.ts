import { MigrationInterface, QueryRunner } from 'typeorm';
import { sqlDeClave } from './sql/tenant-cruzado';

/** Lo que referencia la visita fallida es de la misma distribuidora. */
const CLAVES: ReadonlyArray<[string, string, string]> = [
  ['order_failed_visit', 'order_id', 'order'],
  ['order_failed_visit', 'delivery_id', 'delivery'],
  ['order_failed_visit', 'proposed_time_slot_id', 'time_slot'],
  ['order_failed_visit', 'final_time_slot_id', 'time_slot'],
];

/**
 * Nueva visita cuando no se pudo entregar (C5): el historial de visitas
 * fallidas (`order_failed_visit`: motivo, dónde estaba el chofer, qué se
 * propuso y cómo se resolvió) y, en el pedido, cuántas lleva, el estado de la
 * nueva visita y cuándo fue la última.
 */
export class NuevaVisitaTrasEntregaFallida1795000000180
  implements MigrationInterface
{
  name = 'NuevaVisitaTrasEntregaFallida1795000000180';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "order" ADD "failed_visit_count" integer NOT NULL DEFAULT 0`,
    );
    await q.query(
      `ALTER TABLE "order" ADD "revisit_status" character varying(20)`,
    );
    await q.query(
      `ALTER TABLE "order" ADD "last_failed_visit_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_visitas_fallidas" CHECK ("failed_visit_count" >= 0)`,
    );
    await q.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_nueva_visita_estado" CHECK ("revisit_status" IS NULL OR "revisit_status" IN ('proposed', 'confirmed', 'awaiting_admin'))`,
    );
    await q.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_nueva_visita_con_visita_fallida" CHECK ("revisit_status" IS NULL OR ("failed_visit_count" >= 1 AND "last_failed_visit_at" IS NOT NULL))`,
    );

    await q.query(
      `CREATE TABLE "order_failed_visit" (
        "failed_visit_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "order_id" uuid NOT NULL,
        "distributor_id" uuid NOT NULL,
        "visit_number" integer NOT NULL,
        "delivery_kind" character varying(20) NOT NULL,
        "reason" character varying(30) NOT NULL,
        "note" text,
        "point" geography(Point,4326),
        "accuracy_m" numeric(8,2),
        "distance_m" integer,
        "out_of_range" boolean NOT NULL DEFAULT false,
        "reported_by_user_id" uuid NOT NULL,
        "reported_by_role" character varying(20) NOT NULL,
        "delivery_id" uuid,
        "failed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "outcome" character varying(20) NOT NULL,
        "agreed_with_customer" boolean NOT NULL DEFAULT false,
        "proposed_date" date,
        "proposed_time_slot_id" uuid,
        "resolution" character varying(20),
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by_user_id" uuid,
        "final_date" date,
        "final_time_slot_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_failed_visit" PRIMARY KEY ("failed_visit_id"),
        CONSTRAINT "CHK_order_failed_visit_motivo" CHECK ("reason" IN ('customer_absent', 'address_closed', 'rejected', 'other')),
        CONSTRAINT "CHK_order_failed_visit_nota" CHECK ("note" IS NULL OR char_length("note") <= 300),
        CONSTRAINT "CHK_order_failed_visit_otro_con_nota" CHECK ("reason" <> 'other' OR char_length(btrim(coalesce("note", ''))) >= 3),
        CONSTRAINT "CHK_order_failed_visit_tipo" CHECK ("delivery_kind" IN ('single', 'express', 'route_sheet')),
        CONSTRAINT "CHK_order_failed_visit_resultado" CHECK ("outcome" IN ('requeued', 'proposed', 'agreed', 'awaiting_admin')),
        CONSTRAINT "CHK_order_failed_visit_resolucion" CHECK ("resolution" IS NULL OR "resolution" IN ('customer_accepted', 'customer_changed', 'admin_set')),
        CONSTRAINT "CHK_order_failed_visit_resuelta" CHECK (("resolution" IS NULL) = ("resolved_at" IS NULL)),
        CONSTRAINT "CHK_order_failed_visit_numero" CHECK ("visit_number" >= 1),
        CONSTRAINT "CHK_order_failed_visit_precision" CHECK ("accuracy_m" IS NULL OR ("accuracy_m" >= 0 AND "accuracy_m" <= 10000)),
        CONSTRAINT "CHK_order_failed_visit_distancia" CHECK ("distance_m" IS NULL OR "distance_m" >= 0),
        CONSTRAINT "CHK_order_failed_visit_fuera_de_radio" CHECK (NOT "out_of_range" OR "point" IS NOT NULL),
        CONSTRAINT "CHK_order_failed_visit_rol" CHECK ("reported_by_role" IN ('delivery', 'admin', 'super_admin')),
        CONSTRAINT "CHK_order_failed_visit_acuerdo" CHECK (NOT "agreed_with_customer" OR "proposed_date" IS NOT NULL)
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_order_failed_visit_pedido" ON "order_failed_visit" ("order_id", "failed_at")`,
    );
    await q.query(
      `CREATE INDEX "IDX_order_failed_visit_distribuidora" ON "order_failed_visit" ("distributor_id", "failed_at")`,
    );
    for (const [hijo, columna, padre] of CLAVES) {
      await q.query(sqlDeClave(hijo, columna, padre));
    }
    await q.query(
      `ALTER TABLE "order_failed_visit" ADD CONSTRAINT "FK_order_failed_visit_informada_por" FOREIGN KEY ("reported_by_user_id") REFERENCES "user" ("user_id") ON DELETE RESTRICT`,
    );
    await q.query(
      `ALTER TABLE "order_failed_visit" ADD CONSTRAINT "FK_order_failed_visit_resuelta_por" FOREIGN KEY ("resolved_by_user_id") REFERENCES "user" ("user_id") ON DELETE RESTRICT`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "order_failed_visit"`);
    for (const c of [
      'CHK_order_nueva_visita_con_visita_fallida',
      'CHK_order_nueva_visita_estado',
      'CHK_order_visitas_fallidas',
    ]) {
      await q.query(`ALTER TABLE "order" DROP CONSTRAINT "${c}"`);
    }
    for (const col of [
      'last_failed_visit_at',
      'revisit_status',
      'failed_visit_count',
    ]) {
      await q.query(`ALTER TABLE "order" DROP COLUMN "${col}"`);
    }
  }
}
