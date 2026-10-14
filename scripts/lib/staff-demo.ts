import { DataSource } from 'typeorm';

/**
 * Asigna el perfil de staff (admin o delivery) de `email` a una distribuidora.
 * Idempotente: sobrescribe el distributor_id del perfil y, si la purga de la
 * distribuidora se lo llevó, lo vuelve a crear.
 */
export async function assignStaffToDistributor(
  dataSource: DataSource,
  email: string,
  role: 'admin' | 'super_admin' | 'customer' | 'delivery',
  distributorId: string,
): Promise<void> {
  const table = role === 'delivery' ? 'delivery' : 'admin';
  await dataSource.query(
    `UPDATE ${table} SET distributor_id = $1
       WHERE user_id = (SELECT user_id FROM "user" WHERE email = $2)`,
    [distributorId, email],
  );
  // La purga de una distribuidora se lleva los perfiles de su staff, pero no
  // la cuenta: si el perfil ya no está, se vuelve a crear.
  const columnas =
    table === 'delivery'
      ? '(user_id, distributor_id, validated, "isEnabled")'
      : '(user_id, distributor_id)';
  const valores =
    table === 'delivery' ? 'u.user_id, $1, true, true' : 'u.user_id, $1';
  await dataSource.query(
    `INSERT INTO ${table} ${columnas}
     SELECT ${valores} FROM "user" u
      WHERE u.email = $2
        AND NOT EXISTS (SELECT 1 FROM ${table} p WHERE p.user_id = u.user_id)`,
    [distributorId, email],
  );
}
