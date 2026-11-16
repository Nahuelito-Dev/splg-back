import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { Admin } from '../../../src/admin/entities/admin.entity';
import { RoleType } from '../../../src/common/constants/role-type.enum';
import { Customer } from '../../../src/customer/entities/customer.entity';
import { Delivery } from '../../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../../src/distributor/entities/distributor.entity';
import {
  DistribuidoraCreadaEvent,
  EVENTO_DISTRIBUIDORA_CREADA,
} from '../../../src/distributor/events/distribuidora-creada.event';
import { EmployeeService } from '../../../src/employee/employee.service';
import { GasCylinder } from '../../../src/gascylinder/entities/gascylinder.entity';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '../../../src/order/entities/order.entity';
import { OrderItem } from '../../../src/order/entities/order-item.entity';
import { Role } from '../../../src/role/entities/role.entity';
import { UserAddress } from '../../../src/user-address/entities/user-address.entity';
import { User } from '../../../src/users/entities/user.entity';
import { TestEnv, telefonoDePrueba } from './test-env';
import { fechasDeEntrega, sembrarChoferDeFixture } from './pedido-valido';

export type Headers = Record<string, string>;

export const cuerpo = <T>(res: { body: unknown }): T => res.body as T;

/**
 * Datos de prueba de las suites de finanzas (caja, rendiciones, cuentas
 * corrientes y comisiones): distribuidoras con su admin, choferes con legajo,
 * clientes y pedidos entregados.
 */
export class Finanzas {
  private seq = 0;
  readonly ds: DataSource;

  constructor(private readonly env: TestEnv) {
    this.ds = env.app.get(DataSource);
  }

  async rol(type: string): Promise<Role> {
    const roles = this.ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  private sufijo(): string {
    this.seq += 1;
    return `${this.seq}-${randomUUID().slice(0, 6)}`;
  }

  async distribuidora() {
    const sufijo = this.sufijo();
    const dist = (await this.ds.getRepository(Distributor).save({
      name: `Dist ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    // Igual que el alta real de una distribuidora: se publica el evento y
    // `cash` siembra su "Caja central" y las categorías de sistema.
    await this.env.app
      .get(EventEmitter2)
      .emitAsync(
        EVENTO_DISTRIBUIDORA_CREADA,
        new DistribuidoraCreadaEvent(dist.distributorId),
      );
    const email = `admin.${sufijo}@splg.local`;
    const admin = (await this.ds.getRepository(User).save({
      email,
      fullName: 'Admin Test',
      phoneNumber: telefonoDePrueba(),
      roleId: (await this.rol(RoleType.ADMIN)).roleId,
    } as Partial<User>)) as User;
    await this.ds.getRepository(Admin).save({
      userId: admin.userId,
      distributorId: dist.distributorId,
    } as Partial<Admin>);
    const garrafa = (await this.ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      weight: 10,
      stock: 1000,
      isActive: true,
      distributorId: dist.distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;
    return {
      distributorId: dist.distributorId,
      slug: dist.slug,
      adminUserId: admin.userId,
      garrafa,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'panel-app',
      } as Headers,
    };
  }

  /** Un chofer con perfil de reparto y legajo (el que une comisiones y rendiciones). */
  async chofer(distributorId: string, nombre = 'Chofer Test') {
    const sufijo = this.sufijo();
    const email = `chofer.${sufijo}@splg.local`;
    const telefono = telefonoDePrueba();
    const user = (await this.ds.getRepository(User).save({
      email,
      fullName: nombre,
      phoneNumber: telefono,
      roleId: (await this.rol(RoleType.DELIVERY)).roleId,
    } as Partial<User>)) as User;
    const delivery = (await this.ds.getRepository(Delivery).save({
      userId: user.userId,
      distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>)) as Delivery;
    const empleado = await this.ds.transaction((manager) =>
      this.env.app.get(EmployeeService).crearParaUsuario(manager, {
        userId: user.userId,
        distributorId,
        rol: RoleType.DELIVERY,
        fullName: nombre,
        phoneNumber: telefono,
      }),
    );
    return {
      userId: user.userId,
      deliveryId: delivery.deliveryId,
      employeeId: empleado.employeeId,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source': 'driver-app',
      } as Headers,
    };
  }

  /** Un cliente (usuario con perfil de cliente) y su dirección. */
  async cliente(nombre = 'Cliente Test') {
    const sufijo = this.sufijo();
    const user = (await this.ds.getRepository(User).save({
      email: `cliente-${sufijo}@splg.local`,
      fullName: nombre,
      phoneNumber: telefonoDePrueba(),
      roleId: (await this.rol(RoleType.CUSTOMER)).roleId,
    } as Partial<User>)) as User;
    await this.ds.getRepository(Customer).save({
      userId: user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    const dir = (await this.ds.getRepository(UserAddress).save({
      userId: user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;
    return { userId: user.userId, addressId: dir.addressId };
  }

  /**
   * Un pedido ENTREGADO por el chofer (insertado directo, sin pasar por la
   * máquina de estados: acá se prueba lo que cuelga de la entrega, no la
   * entrega).
   */
  async pedidoEntregado(
    e: { distributorId: string; garrafa: GasCylinder },
    datos: {
      chofer: { deliveryId: string } | null;
      cliente: { userId: string; addressId: string };
      cantidad?: number;
      metodo?: PaymentMethod;
      estadoDePago?: PaymentStatus;
      entregadoEn?: Date;
      sena?: number;
    },
  ): Promise<Order> {
    const cantidad = datos.cantidad ?? 1;
    const metodo = datos.metodo ?? PaymentMethod.CASH;
    const total = 1000 * cantidad;
    const o = (await this.ds.getRepository(Order).save({
      customerId: datos.cliente.userId,
      distributorId: e.distributorId,
      addressId: datos.cliente.addressId,
      status: OrderStatus.DELIVERED,
      paymentMethod: metodo,
      paymentType:
        metodo === PaymentMethod.CASH
          ? PaymentType.CASH
          : metodo === PaymentMethod.ACCOUNT
            ? PaymentType.ACCOUNT
            : PaymentType.ONLINE,
      paymentStatus: datos.estadoDePago ?? PaymentStatus.PENDING,
      totalAmount: total,
      subtotalItems: total,
      depositAmount: datos.sena ?? 0,
      depositPaid: datos.sena !== undefined,
      deliveryId:
        datos.chofer?.deliveryId ??
        (await sembrarChoferDeFixture(this.ds, e.distributorId)).deliveryId,
      ...fechasDeEntrega(datos.entregadoEn ?? new Date()),
    } as Partial<Order>)) as Order;
    await this.ds.getRepository(OrderItem).save({
      orderId: o.orderId,
      gasCylinderId: e.garrafa.gasCylinderId,
      quantity: cantidad,
      unitPrice: 1000,
      subtotal: total,
    } as Partial<OrderItem>);
    return o;
  }
}
