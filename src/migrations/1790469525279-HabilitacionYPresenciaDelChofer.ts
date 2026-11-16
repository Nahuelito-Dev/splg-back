import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `delivery.isActive` mezclaba dos cosas: la habilitación administrativa
 * (¿el admin lo dio de baja?) y la presencia del chofer (¿está en línea?). Un
 * chofer que el admin deshabilitaba podía igual "conectarse" desde su app
 * (`PATCH /delivery/user/:userId/availability`) y volver a recibir pedidos,
 * porque ese mismo endpoint pisaba la única columna que existía.
 *
 * Se separan en dos columnas nuevas:
 *   - `isEnabled`: la pone un admin (`PATCH /delivery/:id/status`).
 *   - `isAvailable`: la pone el propio chofer al conectarse/desconectarse.
 *
 * Backfill:
 *   - `isEnabled = true` para todos. Hoy no hay forma de distinguir, a partir
 *     de un solo booleano mezclado, quién fue deshabilitado por un admin de
 *     quién simplemente estaba desconectado: los dos casos dejaban
 *     `isActive = false`. Ante la duda, no se deja a nadie deshabilitado de
 *     arranque (el `DEFAULT true` de la columna ya cubre esto sin necesidad de
 *     un UPDATE aparte).
 *   - `isAvailable = isActive`: se hereda el valor que tenía como punto de
 *     partida de "en línea", para no desconectar de golpe a los choferes que
 *     hoy están operando. A partir de acá cada endpoint escribe su propia
 *     columna y dejan de pisarse entre sí.
 *
 * `isActive` NO se toca (ni se renombra ni se borra): la base es compartida
 * con el proceso viejo (`:3100`, sin este cambio) mientras conviven las dos
 * versiones, y ese proceso la sigue leyendo y escribiendo.
 */
export class HabilitacionYPresenciaDelChofer1790469525279
  implements MigrationInterface
{
  name = 'HabilitacionYPresenciaDelChofer1790469525279';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delivery" ADD "isEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" ADD "isAvailable" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`UPDATE "delivery" SET "isAvailable" = "isActive"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "delivery" DROP COLUMN "isAvailable"`);
    await queryRunner.query(`ALTER TABLE "delivery" DROP COLUMN "isEnabled"`);
  }
}
