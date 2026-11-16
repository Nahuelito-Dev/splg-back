import type { EntityManager } from 'typeorm';

/**
 * Quién es de la empresa para la bandeja (§4.3, §4.4): lo comparten abrir una
 * conversación, escribir en ella y entrar a su sala.
 */

/** Cliente de la empresa: vínculo vigente o algún pedido con ella (§4.3). */
export async function clienteDeLaEmpresa(
  manager: EntityManager,
  userId: string,
  distributorId: string,
): Promise<boolean> {
  const filas: unknown[] = await manager.query(
    `SELECT 1 FROM "user" u JOIN "role" r ON r."role_id" = u."role_id"
      WHERE u."user_id" = $1 AND r."type" = 'customer' AND u."deletedAt" IS NULL
        AND (EXISTS (SELECT 1 FROM "customer_distributor" cd
                      WHERE cd."user_id" = u."user_id" AND cd."distributor_id" = $2
                        AND cd."removed_at" IS NULL)
             OR EXISTS (SELECT 1 FROM "order" o
                         WHERE o."customer_id" = u."user_id" AND o."distributor_id" = $2))`,
    [userId, distributorId],
  );
  return filas.length > 0;
}

/** Chofer vigente de la empresa (su perfil de reparto es de ella). */
export async function choferDeLaEmpresa(
  manager: EntityManager,
  userId: string,
  distributorId: string,
): Promise<boolean> {
  const filas: unknown[] = await manager.query(
    `SELECT 1 FROM "delivery" d JOIN "user" u ON u."user_id" = d."user_id"
      WHERE d."user_id" = $1 AND d."distributor_id" = $2
        AND d."deletedAt" IS NULL AND u."deletedAt" IS NULL`,
    [userId, distributorId],
  );
  return filas.length > 0;
}
