import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Admin } from '../../../src/admin/entities/admin.entity';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { UpdateOrderStatusUseCase } from '../../../src/order/application/update-order-status.use-case';
import { OrderStatus } from '../../../src/order/entities/order.entity';
import { Role } from '../../../src/role/entities/role.entity';
import { User } from '../../../src/users/entities/user.entity';
import { TestEnv, telefonoDePrueba } from './test-env';

/**
 * Entrega un pedido como lo hace un administrador del panel: con un admin real
 * de la distribuidora del pedido (se siembra si no hay) y el motivo que la
 * entrega manual exige. Así el historial de estados (FK al usuario), la
 * auditoría y los movimientos de stock van en la misma transacción.
 */
export async function entregarComoAdmin(
  env: TestEnv,
  orderId: string,
  reason = 'Entrega manual de prueba',
) {
  const ds = env.app.get(DataSource);
  const [pedido] = await ds.query<Array<{ distributor_id: string }>>(
    `SELECT distributor_id FROM "order" WHERE order_id = $1`,
    [orderId],
  );
  const [existente] = await ds.query<Array<{ user_id: string }>>(
    `SELECT user_id FROM admin WHERE distributor_id = $1 LIMIT 1`,
    [pedido.distributor_id],
  );
  let adminUserId = existente?.user_id;
  if (!adminUserId) {
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: RoleType.ADMIN } })) ??
      (await roles.save({ type: RoleType.ADMIN } as Partial<Role>));
    const user = await ds.getRepository(User).save({
      email: `admin-entrega-${randomUUID().slice(0, 8)}@splg.local`,
      fullName: 'Admin entregas',
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>);
    await ds.getRepository(Admin).save({
      userId: user.userId,
      distributorId: pedido.distributor_id,
    } as Partial<Admin>);
    adminUserId = user.userId;
  }
  return env.app
    .get(UpdateOrderStatusUseCase)
    .execute(
      orderId,
      OrderStatus.DELIVERED,
      undefined,
      RoleType.ADMIN,
      adminUserId,
      reason,
    );
}
