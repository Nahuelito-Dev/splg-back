import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  crearFuncionDeTransicion,
  MAQUINAS_DE_ESTADO,
} from './sql/transiciones-de-estado';

/**
 * Rangos de los parámetros de la recuperación de envases en `module_config`
 * (los de `ESQUEMAS` en `distributor/process-config.ts`). Una clave ausente
 * vale lo de omisión; una presente tiene que ser un número dentro del rango, y
 * entero salvo el umbral de importe.
 */
const RANGOS: ReadonlyArray<[string, number, number]> = [
  ['toleranceDays', 1, 365],
  ['escalationStepDays', 1, 90],
  ['escalationAmountThreshold', 0, 100_000_000],
  ['pickupOfferTtlHours', 1, 720],
  ['pickupWindowDays', 1, 60],
  ['runHour', 0, 23],
];

const CHECK_RECUPERACION = RANGOS.map(
  ([k, min, max]) =>
    `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'escalationAmountThreshold' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
).join(' AND ');

const ENVASE = MAQUINAS_DE_ESTADO.find((m) => m.tabla === 'cylinder');

/** Máquina del envase como estaba antes de poder dar por perdido uno en poder de un cliente. */
const ENVASE_ANTERIOR = ENVASE && {
  ...ENVASE,
  transiciones: { ...ENVASE.transiciones, with_customer: ['empty_returned'] },
};

export class RecuperoDeEnvases1794600000001 implements MigrationInterface {
  name = 'RecuperoDeEnvases1794600000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD "step_due_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD "exhausted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD "order_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD "responded_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD "response_note" character varying(500)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_recovery_notice_pedido" ON "cylinder_recovery_notice" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_recovery_case_distribuidora_estado" ON "cylinder_recovery_case" ("distributor_id", "status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_recovery_case_envase_vivo" ON "cylinder_recovery_case" ("cylinder_id") WHERE "status" IN ('open', 'escalated', 'lost')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_recovery_notice_aviso_por_escalon" ON "cylinder_recovery_notice" ("case_id", "step") WHERE "kind" <> 'pickup_offer'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_recovery_notice_oferta_por_pedido" ON "cylinder_recovery_notice" ("case_id", "order_id") WHERE "kind" = 'pickup_offer'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_recovery_notice_oferta_viva" ON "cylinder_recovery_notice" ("case_id") WHERE "kind" = 'pickup_offer' AND "status" IN ('pending', 'accepted')`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "CHK_recovery_case_importe_y_escalon" CHECK ("deposit_amount" >= 0 AND "step" BETWEEN 1 AND 3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "CHK_recovery_case_estado" CHECK ((("status" IN ('open', 'escalated', 'lost')) = ("closed_at" IS NULL)) AND ("status" NOT IN ('escalated', 'lost') OR "exhausted_at" IS NOT NULL) AND ("status" NOT IN ('deposit_charged', 'written_off', 'closed_no_charge') OR ("resolution_note" IS NOT NULL AND btrim("resolution_note") <> '')))`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD CONSTRAINT "CHK_recovery_notice_oferta" CHECK ((("kind" = 'pickup_offer') = ("order_id" IS NOT NULL)) AND (("kind" = 'pickup_offer') = ("status" IS NOT NULL)) AND ("status" NOT IN ('accepted', 'rejected') OR "responded_at" IS NOT NULL) AND ("status" <> 'pending' OR "responded_at" IS NULL) AND ("expires_at" >= "sent_at") AND ("step" BETWEEN 1 AND 3))`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD CONSTRAINT "FK_b45aff91a16b22611613296d476" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recuperacion" CHECK ("module" <> 'cylinder_recovery' OR (${CHECK_RECUPERACION}))`,
    );
    // El envase en poder de un cliente se puede dar por perdido (CU-108).
    if (ENVASE) {
      await queryRunner.query(
        crearFuncionDeTransicion(ENVASE).replace(
          'CREATE FUNCTION',
          'CREATE OR REPLACE FUNCTION',
        ),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (ENVASE_ANTERIOR) {
      await queryRunner.query(
        crearFuncionDeTransicion(ENVASE_ANTERIOR).replace(
          'CREATE FUNCTION',
          'CREATE OR REPLACE FUNCTION',
        ),
      );
    }
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recuperacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP CONSTRAINT "FK_b45aff91a16b22611613296d476"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP CONSTRAINT "CHK_recovery_notice_oferta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "CHK_recovery_case_estado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "CHK_recovery_case_importe_y_escalon"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_recovery_notice_oferta_viva"`);
    await queryRunner.query(
      `DROP INDEX "UQ_recovery_notice_oferta_por_pedido"`,
    );
    await queryRunner.query(
      `DROP INDEX "UQ_recovery_notice_aviso_por_escalon"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_recovery_case_envase_vivo"`);
    await queryRunner.query(
      `DROP INDEX "IDX_recovery_case_distribuidora_estado"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_recovery_notice_pedido"`);
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP COLUMN "response_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP COLUMN "responded_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP COLUMN "order_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP COLUMN "exhausted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP COLUMN "step_due_at"`,
    );
  }
}
