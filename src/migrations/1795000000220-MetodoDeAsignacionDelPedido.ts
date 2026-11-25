import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cómo se asignó el pedido a su chofer (M1): despacho automático, asignación
 * manual, hoja de ruta o lote. Los pedidos anteriores quedan en `null`: no se
 * les inventa un método.
 */
export class MetodoDeAsignacionDelPedido1795000000220
  implements MigrationInterface
{
  name = 'MetodoDeAsignacionDelPedido1795000000220';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "order" ADD "assignment_method" character varying(20)`,
    );
    await q.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_metodo_de_asignacion" CHECK ("assignment_method" IS NULL OR "assignment_method" IN ('automatic', 'manual_override', 'route_sheet', 'batch'))`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_metodo_de_asignacion"`,
    );
    await q.query(`ALTER TABLE "order" DROP COLUMN "assignment_method"`);
  }
}
