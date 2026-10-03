import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `order.acceptedAt/onTheWayAt/deliveredAt` y `claims.createdAt` eran
 * `timestamp` sin zona: guardaban la hora de pared del proceso que escribía
 * (o, en `claims`, la del `DEFAULT now()` de la sesión de la base, que es UTC).
 * Los datos de desarrollo se escribieron con el proceso en hora argentina: la
 * conversión los interpreta como America/Argentina/Buenos_Aires y el instante
 * no se corre.
 *
 * La migración NO adivina: antes de convertir verifica que los datos encajen
 * con esa hipótesis y, si no, aborta con un mensaje (nada queda a medias).
 *   - order: leídas como hora argentina, las tres fechas tienen que estar entre
 *     `createdAt` y `updatedAt` (ambas timestamptz; `onTheWayAt` sólo contra
 *     `createdAt`) y no en el futuro.
 *   - claims: ningún reclamo puede tener fracción de segundo (el seed no la
 *     trae; `DEFAULT now()` sí, y es UTC), ni anterior al pedido, ni futuro.
 *
 * Runbook para otro entorno (VPS en UTC, base restaurada): MEDIR ANTES de correr.
 *   1. Pedidos que no encajan (esperado 0):
 *      SELECT count(*) FROM "order" o WHERE
 *        ("acceptedAt" AT TIME ZONE 'America/Argentina/Buenos_Aires' > o."updatedAt" + interval '1 minute')
 *     OR ("deliveredAt" AT TIME ZONE 'America/Argentina/Buenos_Aires' > o."updatedAt" + interval '1 minute');
 *   2. Reclamos con fracción (escritos por la API, hora UTC; esperado 0):
 *      SELECT count(*) FROM claims WHERE "createdAt" <> date_trunc('second', "createdAt");
 *   3. Si hay filas de otra zona: convertir cada población con su zona a mano
 *      (ALTER … TYPE timestamptz USING col AT TIME ZONE '<zona>'), registrar la
 *      migración en la tabla `migrations` y no correr ésta.
 */
const ZONA = 'America/Argentina/Buenos_Aires';

const COLUMNAS: ReadonlyArray<readonly [string, string]> = [
  ['order', 'acceptedAt'],
  ['order', 'onTheWayAt'],
  ['order', 'deliveredAt'],
  ['claims', 'createdAt'],
];

export class OrderTimestampsConZona1791000000000 implements MigrationInterface {
  name = 'OrderTimestampsConZona1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.verificarZona(queryRunner);
    for (const [tabla, columna] of COLUMNAS) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ALTER COLUMN "${columna}" TYPE TIMESTAMP WITH TIME ZONE USING "${columna}" AT TIME ZONE '${ZONA}'`,
      );
    }
  }

  private async verificarZona(queryRunner: QueryRunner): Promise<void> {
    // `onTheWayAt` no se compara con `updatedAt`: el seed de demostración deja
    // `updatedAt` en el momento de la aceptación en los pedidos en camino.
    const fueraDeRango = (col: string, contraUpdatedAt = true) =>
      `("${col}" IS NOT NULL AND (${contraUpdatedAt ? `"${col}" AT TIME ZONE '${ZONA}' > o."updatedAt" + interval '1 minute' OR` : 'false OR'}
         "${col}" AT TIME ZONE '${ZONA}' < o."createdAt" - interval '1 minute'
        OR "${col}" AT TIME ZONE '${ZONA}' > now() + interval '1 minute'))`;
    const pedidos = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "order" o WHERE ${fueraDeRango('acceptedAt')} OR ${fueraDeRango('onTheWayAt', false)} OR ${fueraDeRango('deliveredAt')}`,
    )) as { n: number }[];
    const reclamos = (await queryRunner.query(
      `SELECT count(*) FILTER (WHERE c."createdAt" <> date_trunc('second', c."createdAt"))::int AS con_fraccion,
              count(*) FILTER (WHERE c."createdAt" AT TIME ZONE '${ZONA}' < o."createdAt" - interval '1 minute'
                OR c."createdAt" AT TIME ZONE '${ZONA}' > now() + interval '1 minute')::int AS fuera_de_rango
         FROM claims c JOIN "order" o ON o."order_id" = c."order_id"`,
    )) as { con_fraccion: number; fuera_de_rango: number }[];
    if (
      pedidos[0].n > 0 ||
      reclamos[0].con_fraccion > 0 ||
      reclamos[0].fuera_de_rango > 0
    ) {
      throw new Error(
        `OrderTimestampsConZona abortada: los datos no encajan con hora argentina ` +
          `(pedidos fuera de rango: ${pedidos[0].n}, reclamos con fracción de segundo: ${reclamos[0].con_fraccion}, ` +
          `reclamos fuera de rango: ${reclamos[0].fuera_de_rango}). Medí y convertí a mano; ver el runbook en el comentario de la migración.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [tabla, columna] of COLUMNAS) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ALTER COLUMN "${columna}" TYPE TIMESTAMP WITHOUT TIME ZONE USING "${columna}" AT TIME ZONE '${ZONA}'`,
      );
    }
  }
}
