import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CU-153: "el registro no se puede modificar ni borrar, porque un registro
 * editable no prueba nada". Además de que la API no tiene cómo hacerlo, la
 * base lo impide: un trigger rechaza todo UPDATE y DELETE sobre audit_log.
 *
 * La única modificación permitida es la que hacen las claves foráneas al
 * borrarse la distribuidora o el usuario (ON DELETE SET NULL): vaciar esas dos
 * referencias, sin tocar nada más del asiento.
 */
export class AuditoriaInmutable1790347500000 implements MigrationInterface {
  name = 'AuditoriaInmutable1790347500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION audit_log_inmutable() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE'
           AND (NEW.distributor_id IS NULL OR NEW.distributor_id = OLD.distributor_id)
           AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id)
           AND (to_jsonb(NEW) - 'distributor_id' - 'actor_user_id')
             = (to_jsonb(OLD) - 'distributor_id' - 'actor_user_id') THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'audit_log es de sólo escritura: no se modifican ni se borran asientos';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_log_inmutable
      BEFORE UPDATE OR DELETE ON "audit_log"
      FOR EACH ROW EXECUTE FUNCTION audit_log_inmutable()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_log_inmutable ON "audit_log"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_log_inmutable()`);
  }
}
