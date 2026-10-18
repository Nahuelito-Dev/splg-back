import { EntityManager } from 'typeorm';

/**
 * Quién es el empleado de un chofer. Un chofer (`delivery`) y su legajo
 * (`employee`) se unen por la cuenta de acceso (`user_id`). Es de sólo lectura
 * y vive acá, como `pertenencia.ts`, porque la usan varios módulos de finanzas
 * (rendiciones, comisiones, cuentas corrientes) sin depender del de personal.
 */
export interface EmpleadoDelChofer {
  employeeId: string;
  deliveryId: string;
  userId: string;
  distributorId: string;
  fullName: string;
}

export async function empleadoDelChofer(
  manager: EntityManager,
  deliveryId: string,
): Promise<EmpleadoDelChofer | null> {
  const [fila]: Array<{
    employee_id: string;
    delivery_id: string;
    user_id: string;
    distributor_id: string;
    full_name: string | null;
  }> = await manager.query(
    `SELECT e."employee_id", d."delivery_id", d."user_id", d."distributor_id", u."full_name" AS full_name
     FROM "delivery" d
     JOIN "employee" e ON e."user_id" = d."user_id" AND e."distributor_id" = d."distributor_id" AND e."deletedAt" IS NULL
     JOIN "user" u ON u."user_id" = d."user_id"
     WHERE d."delivery_id" = $1`,
    [deliveryId],
  );
  return fila ? aEmpleado(fila) : null;
}

/** El legajo de quien está en sesión (rol chofer) en esa distribuidora. */
export async function empleadoDelUsuario(
  manager: EntityManager,
  userId: string,
  distributorId: string,
): Promise<EmpleadoDelChofer | null> {
  const [fila]: Array<{
    employee_id: string;
    delivery_id: string;
    user_id: string;
    distributor_id: string;
    full_name: string | null;
  }> = await manager.query(
    `SELECT e."employee_id", d."delivery_id", d."user_id", d."distributor_id", u."full_name" AS full_name
     FROM "delivery" d
     JOIN "employee" e ON e."user_id" = d."user_id" AND e."distributor_id" = d."distributor_id" AND e."deletedAt" IS NULL
     JOIN "user" u ON u."user_id" = d."user_id"
     WHERE d."user_id" = $1 AND d."distributor_id" = $2`,
    [userId, distributorId],
  );
  return fila ? aEmpleado(fila) : null;
}

/** El chofer (`delivery`) de un legajo, si su cuenta tiene perfil de chofer. */
export async function choferDelEmpleado(
  manager: EntityManager,
  employeeId: string,
  distributorId: string,
): Promise<EmpleadoDelChofer | null> {
  const [fila]: Array<{
    employee_id: string;
    delivery_id: string;
    user_id: string;
    distributor_id: string;
    full_name: string | null;
  }> = await manager.query(
    `SELECT e."employee_id", d."delivery_id", d."user_id", d."distributor_id", u."full_name" AS full_name
     FROM "employee" e
     JOIN "delivery" d ON d."user_id" = e."user_id" AND d."distributor_id" = e."distributor_id"
     JOIN "user" u ON u."user_id" = e."user_id"
     WHERE e."employee_id" = $1 AND e."distributor_id" = $2 AND e."deletedAt" IS NULL`,
    [employeeId, distributorId],
  );
  return fila ? aEmpleado(fila) : null;
}

function aEmpleado(fila: {
  employee_id: string;
  delivery_id: string;
  user_id: string;
  distributor_id: string;
  full_name: string | null;
}): EmpleadoDelChofer {
  return {
    employeeId: fila.employee_id,
    deliveryId: fila.delivery_id,
    userId: fila.user_id,
    distributorId: fila.distributor_id,
    fullName: fila.full_name ?? '',
  };
}

/** El `delivery_id` del perfil de chofer de un usuario en esa distribuidora. */
export async function deliveryIdDelUsuario(
  manager: EntityManager,
  userId: string,
  distributorId: string,
): Promise<string | null> {
  const [fila]: Array<{ delivery_id: string }> = await manager.query(
    `SELECT "delivery_id" FROM "delivery" WHERE "user_id" = $1 AND "distributor_id" = $2`,
    [userId, distributorId],
  );
  return fila?.delivery_id ?? null;
}
