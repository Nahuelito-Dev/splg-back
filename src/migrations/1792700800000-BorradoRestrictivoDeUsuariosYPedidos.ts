import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El sistema da de baja, no borra: un usuario o un pedido no se llevan puestos
 * a sus perfiles, direcciones, calificaciones, incidentes ni historial. Las
 * claves pasan de CASCADE a RESTRICT, así un DELETE físico accidental falla en
 * vez de destruir la historia.
 */
const CLAVES: ReadonlyArray<readonly [string, string, string, string, string]> =
  [
    [
      'customer',
      'user_id',
      'FK_5d1f609371a285123294fddcf3a',
      'user',
      'user_id',
    ],
    [
      'delivery',
      'user_id',
      'FK_a3b8af1ce2f6e143d416d83080a',
      'user',
      'user_id',
    ],
    ['car', 'user_id', 'FK_c8d34198d86de9e96aae03b8990', 'user', 'user_id'],
    [
      'user_address',
      'user_id',
      'FK_29d6df815a78e4c8291d3cf5e53',
      'user',
      'user_id',
    ],
    ['admin', 'user_id', 'FK_a28028ba709cd7e5053a86857b4', 'user', 'user_id'],
    [
      'rating',
      'order_id',
      'FK_beb6f44b22a7f1ed7cad984a2e1',
      'order',
      'order_id',
    ],
    [
      'incident',
      'order_id',
      'FK_8a89ba6c226022354d0d8b4ada0',
      'order',
      'order_id',
    ],
    [
      'order_status_history',
      'order_id',
      'FK_1ca7d5228cf9dc589b60243933c',
      'order',
      'order_id',
    ],
    [
      'order_address_change',
      'order_id',
      'FK_4c82c1fe16612f55a925ec87741',
      'order',
      'order_id',
    ],
  ];

export class BorradoRestrictivoDeUsuariosYPedidos1792700800000
  implements MigrationInterface
{
  name = 'BorradoRestrictivoDeUsuariosYPedidos1792700800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.cambiar(queryRunner, 'RESTRICT');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.cambiar(queryRunner, 'CASCADE');
  }

  private async cambiar(
    queryRunner: QueryRunner,
    alBorrar: 'RESTRICT' | 'CASCADE',
  ): Promise<void> {
    for (const [tabla, columna, nombre, destino, pk] of CLAVES) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${nombre}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${nombre}" FOREIGN KEY ("${columna}") REFERENCES "${destino}" ("${pk}") ON DELETE ${alBorrar}`,
      );
    }
  }
}
