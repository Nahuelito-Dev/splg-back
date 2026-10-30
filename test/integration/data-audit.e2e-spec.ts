/**
 * Integración de la auditoría de datos (Auditoria, DetalleAuditoria y
 * TipoAccionAuditoria): el subscriber global de TypeORM, el contexto del
 * request, la atomicidad con la transacción del cambio y la API de consulta.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  sembrarClienteAutenticado,
  truncateAllTables,
} from './setup/test-env';
import { Audit } from '../../src/audit/entities/audit.entity';
import { AuditDetail } from '../../src/audit/entities/audit-detail.entity';
import { AuditActionTypeId } from '../../src/audit/entities/audit-action-type.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { User } from '../../src/users/entities/user.entity';
import { Role } from '../../src/role/entities/role.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { StorageOrphan } from '../../src/s3/entities/storage-orphan.entity';
import { RoleType } from '../../src/common/constants/role-type.enum';
import { Car } from '../../src/car/entities/car.entity';
import { VehicleAssignmentService } from '../../src/car/vehicle-assignment.service';
import { CustomersService } from '../../src/customer/customer.service';
import { UsersService } from '../../src/users/users.service';
import { GasCylinderService } from '../../src/gascylinder/gascylinder.service';
import { GasCylinderPromotion } from '../../src/gascylinder/entities/gascylinder-promotion.entity';
import { DeliveryService } from '../../src/delivery/delivery.service';
import { auditContext } from '../../src/audit/data/audit-context';
import { AuditoriaDeDatos } from '../../src/audit/data/auditoria-de-datos';

interface Entrada {
  auditId: string;
  actionType: { id: number; name: string };
  user: { userId: string; email: string | null } | null;
  distributorId: string | null;
  entity: string;
  recordId: string;
  ip: string | null;
  dateTime: string;
  details: Array<{
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }>;
}
interface Pagina {
  data: Entrada[];
  total: number;
}

describe('Auditoría de datos (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const distribuidora = (nombre = 'Dist') =>
    ds.getRepository(Distributor).save({
      name: nombre,
      slug: `d-${randomUUID().slice(0, 8)}`,
    } as Partial<Distributor>);

  const garrafa = (distributorId: string) =>
    ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 5,
      weight: 10,
      isActive: true,
      distributorId,
    } as Partial<GasCylinder>);

  const auditorias = (entity: string, recordId: string) =>
    ds.getRepository(Audit).find({
      where: { entity, recordId },
      order: { createdAt: 'ASC' },
    });

  const detalles = (auditId: string) =>
    ds.getRepository(AuditDetail).find({ where: { auditId } });

  const seedRol = async (type: RoleType) =>
    (await ds.getRepository(Role).findOneBy({ type })) ??
    ds.getRepository(Role).save({ type } as Partial<Role>);

  async function seedAdmin(tipo: RoleType, distributorId: string | null) {
    const sufijo = randomUUID().slice(0, 8);
    const rol = await seedRol(tipo);
    const user = await ds.getRepository(User).save({
      email: `${tipo}.${sufijo}@test.local`,
      fullName: `Admin ${sufijo}`,
      roleId: rol.roleId,
    } as Partial<User>);
    await ds
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId } as Partial<Admin>);
    return user;
  }

  const get = (quien: User, url: string, tenant?: string) => {
    const req = request(env.app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${quien.email}`)
      .set('X-Client-Source', 'panel-app');
    return tenant ? req.set('X-Distributor', tenant) : req;
  };

  it('el alta deja una Auditoria Alta con el id del registro y un detalle por campo con valor', async () => {
    const d = await distribuidora();
    const g = await garrafa(d.distributorId);

    const [a] = await auditorias('GasCylinder', g.gasCylinderId);
    expect(a.actionTypeId).toBe(AuditActionTypeId.CREATE);
    expect(a.recordId).toBe(g.gasCylinderId);
    expect(a.distributorId).toBe(d.distributorId);
    expect(a.userId).toBeNull();
    const det = await detalles(a.auditId);
    const porCampo = new Map(det.map((x) => [x.field, x]));
    expect(porCampo.get('type')).toMatchObject({
      oldValue: null,
      newValue: '10kg',
    });
    expect(porCampo.get('stock')?.newValue).toBe('5');
    expect(porCampo.get('isActive')?.newValue).toBe('true');
    expect(porCampo.get('price')?.newValue).toBe('1000.00');
    // los campos sin valor no generan detalle
    expect(porCampo.has('deletedAt')).toBe(false);
  });

  it('la modificación registra sólo los campos que cambiaron, con anterior y nuevo', async () => {
    const d = await distribuidora();
    const g = await garrafa(d.distributorId);

    const cargada = await ds
      .getRepository(GasCylinder)
      .findOneByOrFail({ gasCylinderId: g.gasCylinderId });
    cargada.stock = 9;
    cargada.price = 1250;
    await ds.getRepository(GasCylinder).save(cargada);

    const todas = await auditorias('GasCylinder', g.gasCylinderId);
    expect(todas.map((a) => a.actionTypeId)).toEqual([
      AuditActionTypeId.CREATE,
      AuditActionTypeId.UPDATE,
    ]);
    const det = await detalles(todas[1].auditId);
    expect(
      det
        .map((x) => [x.field, x.oldValue, x.newValue])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['price', '1000.00', '1250.00'],
      ['stock', '5', '9'],
    ]);
  });

  it('guardar sin cambios no escribe nada', async () => {
    const d = await distribuidora();
    const g = await garrafa(d.distributorId);
    const antes = await ds.getRepository(Audit).count();

    const cargada = await ds
      .getRepository(GasCylinder)
      .findOneByOrFail({ gasCylinderId: g.gasCylinderId });
    await ds.getRepository(GasCylinder).save(cargada);
    cargada.stock = 5; // mismo valor que ya tiene
    await ds.getRepository(GasCylinder).save(cargada);

    expect(await ds.getRepository(Audit).count()).toBe(antes);
  });

  it('baja lógica y reactivación quedan con el campo deletedAt', async () => {
    const rol = await seedRol(RoleType.CUSTOMER);
    const u = await ds.getRepository(User).save({
      email: 'baja@test.local',
      fullName: 'Baja',
      roleId: rol.roleId,
    } as Partial<User>);

    await ds.getRepository(User).softRemove(u);
    const baja = await ds
      .getRepository(User)
      .findOneOrFail({ where: { userId: u.userId }, withDeleted: true });
    await ds.getRepository(User).recover(baja);

    const todas = await auditorias('User', u.userId);
    expect(todas.map((a) => a.actionTypeId)).toEqual([
      AuditActionTypeId.CREATE,
      AuditActionTypeId.SOFT_DELETE,
      AuditActionTypeId.RESTORE,
    ]);
    const [b] = await detalles(todas[1].auditId);
    expect(b.field).toBe('deletedAt');
    expect(b.oldValue).toBeNull();
    expect(new Date(b.newValue ?? '').getTime()).not.toBeNaN();
    const [r] = await detalles(todas[2].auditId);
    expect(r.field).toBe('deletedAt');
    expect(r.oldValue).not.toBeNull();
    expect(r.newValue).toBeNull();
  });

  it('si la transacción hace rollback no queda auditoría', async () => {
    const d = await distribuidora();
    let id = '';
    await expect(
      ds.transaction(async (manager) => {
        const g = await manager.getRepository(GasCylinder).save({
          type: '15kg',
          price: 10,
          stock: 1,
          weight: 15,
          isActive: true,
          distributorId: d.distributorId,
        } as Partial<GasCylinder>);
        id = g.gasCylinderId;
        // la auditoría ya se escribió dentro de la transacción
        expect(
          await manager.getRepository(Audit).count({ where: { recordId: id } }),
        ).toBe(1);
        throw new Error('se deshace');
      }),
    ).rejects.toThrow('se deshace');

    expect(await auditorias('GasCylinder', id)).toHaveLength(0);
    expect(
      await ds.getRepository(AuditDetail).count({ where: { field: 'type' } }),
    ).toBe(0);
  });

  it('los secretos se registran como [oculto], también en el valor anterior', async () => {
    const { user } = await sembrarClienteAutenticado(env.app);
    const cliente = await ds
      .getRepository(Customer)
      .findOneByOrFail({ userId: user.userId });
    cliente.notificationToken = 'token-fcm-secreto-1';
    await ds.getRepository(Customer).save(cliente);
    cliente.notificationToken = 'token-fcm-secreto-2';
    await ds.getRepository(Customer).save(cliente);

    const todas = await auditorias('Customer', cliente.customerId);
    const det = await Promise.all(todas.map((a) => detalles(a.auditId)));
    const tokens = det
      .flat()
      .filter((x) => x.field === 'notificationToken')
      .map((x) => [x.oldValue, x.newValue]);
    // alta con token 'fake-fcm', y dos modificaciones
    expect(tokens).toEqual(
      expect.arrayContaining([
        [null, '[oculto]'],
        ['[oculto]', '[oculto]'],
      ]),
    );
    const todo = JSON.stringify(await ds.getRepository(AuditDetail).find());
    expect(todo).not.toContain('secreto');
    expect(todo).not.toContain('fake-fcm');
  });

  it('una entidad excluida no se audita', async () => {
    await ds.getRepository(StorageOrphan).save({
      storageKey: `k-${randomUUID()}`,
    } as Partial<StorageOrphan>);
    expect(await ds.getRepository(Audit).count()).toBe(0);
  });

  it('la posición del chofer no se audita, el resto de sus campos sí', async () => {
    const d = await distribuidora();
    const rol = await seedRol(RoleType.DELIVERY);
    const u = await ds.getRepository(User).save({
      email: 'chofer@test.local',
      roleId: rol.roleId,
    } as Partial<User>);
    const chofer = await ds.getRepository(Delivery).save({
      distributorId: d.distributorId,
      userId: u.userId,
    } as Partial<Delivery>);
    const antes = await ds.getRepository(Audit).count();

    const c = await ds
      .getRepository(Delivery)
      .findOneByOrFail({ deliveryId: chofer.deliveryId });
    c.actualLocation = 'Av. Siempreviva 742';
    c.location = { type: 'Point', coordinates: [-58.38, -34.6] };
    await ds.getRepository(Delivery).save(c);
    expect(await ds.getRepository(Audit).count()).toBe(antes);

    c.actualLocation = 'Otra calle';
    c.calification = 4.5;
    await ds.getRepository(Delivery).save(c);
    const todas = await auditorias('Delivery', chofer.deliveryId);
    const ultima = todas[todas.length - 1];
    expect(ultima.actionTypeId).toBe(AuditActionTypeId.UPDATE);
    expect((await detalles(ultima.auditId)).map((x) => x.field)).toEqual([
      'calification',
    ]);
  });

  it('la escritura manual (helper) también es atómica con la transacción', async () => {
    const d = await distribuidora();
    await expect(
      ds.transaction(async (manager) => {
        await AuditoriaDeDatos.registrar(manager, {
          actionTypeId: AuditActionTypeId.UPDATE,
          entity: 'Manual',
          recordId: 'x1',
          distributorId: d.distributorId,
          details: [{ field: 'campo', oldValue: 'a', newValue: 'b' }],
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await auditorias('Manual', 'x1')).toHaveLength(0);

    await ds.transaction((manager) =>
      AuditoriaDeDatos.registrar(manager, {
        actionTypeId: AuditActionTypeId.UPDATE,
        entity: 'Manual',
        recordId: 'x1',
        distributorId: d.distributorId,
        details: [{ field: 'campo', oldValue: 'a', newValue: 'b' }],
      }),
    );
    expect(await auditorias('Manual', 'x1')).toHaveLength(1);
  });

  it('cerrar una asignación de vehículo (query builder) también se audita, con anterior y nuevo', async () => {
    const d = await distribuidora();
    const rol = await seedRol(RoleType.DELIVERY);
    const crearChofer = async (email: string) => {
      const u = await ds.getRepository(User).save({
        email,
        roleId: rol.roleId,
      } as Partial<User>);
      return ds.getRepository(Delivery).save({
        distributorId: d.distributorId,
        userId: u.userId,
      } as Partial<Delivery>);
    };
    const choferA = await crearChofer('a@test.local');
    const choferB = await crearChofer('b@test.local');
    const auto = await ds.getRepository(Car).save({
      distributorId: d.distributorId,
      userId: choferA.userId,
      carPatent: 'AUD123',
    } as Partial<Car>);
    const servicio = env.app.get(VehicleAssignmentService);

    const primera = await servicio.ponerEnUso(
      choferA.deliveryId,
      auto.carId,
      null,
      d.distributorId,
      choferA.userId,
    );
    await servicio.ponerEnUso(
      choferB.deliveryId,
      auto.carId,
      null,
      d.distributorId,
      choferB.userId,
    );

    const todas = await auditorias('VehicleAssignment', primera.assignmentId);
    expect(todas.map((a) => a.actionTypeId)).toEqual([
      AuditActionTypeId.CREATE,
      AuditActionTypeId.UPDATE,
    ]);
    const det = await detalles(todas[1].auditId);
    const porCampo = new Map(det.map((x) => [x.field, x]));
    expect(porCampo.get('releasedAt')?.oldValue).toBeNull();
    expect(porCampo.get('releasedAt')?.newValue).not.toBeNull();
    expect(porCampo.get('releasedByUserId')).toMatchObject({
      oldValue: null,
      newValue: choferB.userId,
    });
  });

  it('la baja del cliente y el cambio de correo (antes update/softDelete) quedan auditados', async () => {
    const { user } = await sembrarClienteAutenticado(env.app);
    const cliente = await ds
      .getRepository(Customer)
      .findOneByOrFail({ userId: user.userId });

    await env.app
      .get(UsersService)
      .cambiarEmail(user.userId, 'Nuevo@Test.Local');
    const delUsuario = await auditorias('User', user.userId);
    const mod = delUsuario[delUsuario.length - 1];
    expect(mod.actionTypeId).toBe(AuditActionTypeId.UPDATE);
    const det = await detalles(mod.auditId);
    expect(det.find((x) => x.field === 'email')).toMatchObject({
      oldValue: user.email,
      newValue: 'nuevo@test.local',
    });

    await env.app.get(CustomersService).remove(cliente.customerId);
    const delCliente = await auditorias('Customer', cliente.customerId);
    const baja = delCliente[delCliente.length - 1];
    expect(baja.actionTypeId).toBe(AuditActionTypeId.SOFT_DELETE);
    expect((await detalles(baja.auditId)).map((x) => x.field)).toEqual([
      'deletedAt',
    ]);
    // la baja del cliente no arrastró al usuario
    const usuario = await ds
      .getRepository(User)
      .findOneByOrFail({ userId: user.userId });
    expect(usuario.deletedAt).toBeNull();
  });

  it('las promociones que salen de la lista se dan de baja (no se borran) y quedan auditadas', async () => {
    const d = await distribuidora();
    const servicio = env.app.get(GasCylinderService);
    const g = await servicio.create(
      {
        type: '10kg',
        weight: 10,
        price: 1000,
        promotions: [
          { quantity: 3, discountPercentage: 10 },
          { quantity: 5, discountPercentage: 15 },
        ],
      },
      d.distributorId,
    );
    await servicio.update(
      g.gasCylinderId,
      { promotions: [{ quantity: 7, discountPercentage: 20 }] },
      d.distributorId,
    );

    const filas = await ds
      .getRepository(GasCylinderPromotion)
      .find({ withDeleted: true, where: { gasCylinderId: g.gasCylinderId } });
    expect(filas).toHaveLength(3);
    const baja = filas.find((p) => p.quantity === 3);
    expect(baja?.deletedAt).not.toBeNull();
    const auditorias = await ds.getRepository(Audit).find({
      where: { entity: 'GasCylinderPromotion', recordId: baja?.promotionId },
    });
    expect(auditorias.map((a) => a.actionTypeId)).toEqual(
      expect.arrayContaining([AuditActionTypeId.SOFT_DELETE]),
    );
    // la promoción de baja no se lista ni entra en el precio
    const vigente = await servicio.findOne(g.gasCylinderId, d.distributorId);
    expect(vigente.promotions?.map((p) => p.quantity)).toEqual([7]);
    // y la cantidad se puede volver a cargar (la unicidad es entre vigentes)
    await servicio.update(
      g.gasCylinderId,
      {
        promotions: [{ quantity: 3, discountPercentage: 12 }],
      },
      d.distributorId,
    );
    const otra = await servicio.findOne(g.gasCylinderId, d.distributorId);
    expect(otra.promotions?.map((p) => p.quantity)).toEqual([3]);
  });

  it('un borrado físico que quede deja una Baja física con los valores que tenía', async () => {
    const rol = await ds
      .getRepository(Role)
      .save({ type: 'rol-temporal' } as Partial<Role>);
    await ds.getRepository(Role).remove(rol);
    const [alta, baja] = await auditorias('Role', rol.roleId || '');
    expect(alta).toBeUndefined();
    const todas = await ds
      .getRepository(Audit)
      .find({ where: { entity: 'Role', actionTypeId: 5 } });
    expect(todas).toHaveLength(1);
    expect(baja).toBeUndefined();
    const det = await detalles(todas[0].auditId);
    expect(det.find((x) => x.field === 'type')).toMatchObject({
      oldValue: 'rol-temporal',
      newValue: null,
    });
  });

  it('la consulta muestra al usuario aunque esté dado de baja, con la marca', async () => {
    const d = await distribuidora();
    const admin = await seedAdmin(RoleType.ADMIN, d.distributorId);
    const sup = await seedAdmin(RoleType.SUPER_ADMIN, null);
    await auditContext.run(
      { userId: admin.userId, ip: '10.0.0.1', distributorId: d.distributorId },
      () => garrafa(d.distributorId),
    );
    await ds.getRepository(User).softRemove(admin);

    const res = await get(
      sup,
      `/audit/entries?entity=GasCylinder&userId=${admin.userId}`,
    ).expect(200);
    const [e] = (res.body as Pagina).data as Array<
      Entrada & { userId: string | null; user: { deleted: boolean } | null }
    >;
    expect(e.userId).toBe(admin.userId);
    expect(e.user).toMatchObject({ email: admin.email, deleted: true });
  });

  it('un teléfono con cero adelante no se confunde con el número sin cero', async () => {
    const u = await ds.getRepository(User).save({
      email: 'tel@test.local',
      phoneNumber: '03764123456',
    } as Partial<User>);
    u.phoneNumber = '3764123456';
    await ds.getRepository(User).save(u);
    const todas = await auditorias('User', u.userId);
    expect(todas).toHaveLength(2);
    expect(
      (await detalles(todas[1].auditId)).find((x) => x.field === 'phoneNumber'),
    ).toMatchObject({ oldValue: '03764123456', newValue: '3764123456' });
  });

  it('lo de la persona o global no toma la distribuidora del request; lo de la distribuidora sí', async () => {
    const d = await distribuidora();
    const contexto = {
      userId: null,
      ip: null,
      distributorId: d.distributorId,
    };
    const { u, direccion, g } = await auditContext.run(contexto, async () => {
      const usuario = await ds.getRepository(User).save({
        email: 'persona@test.local',
      } as Partial<User>);
      const dir = await ds.getRepository(UserAddress).save({
        userId: usuario.userId,
        street: 'Av. 1',
        city: 'CABA',
        latitude: '-34.6',
        longitude: '-58.4',
      } as Partial<UserAddress>);
      const gar = await garrafa(d.distributorId);
      await ds.getRepository(GasCylinderPromotion).save({
        gasCylinderId: gar.gasCylinderId,
        quantity: 3,
        discountPercentage: 5,
      } as Partial<GasCylinderPromotion>);
      return { u: usuario, direccion: dir, g: gar };
    });
    expect((await auditorias('User', u.userId))[0].distributorId).toBeNull();
    expect(
      (await auditorias('UserAddress', direccion.addressId))[0].distributorId,
    ).toBeNull();
    const promo = await ds.getRepository(Audit).findOneByOrFail({
      entity: 'GasCylinderPromotion',
    });
    expect(promo.distributorId).toBe(d.distributorId);
    expect(g.distributorId).toBe(d.distributorId);
  });

  it('la calificación del chofer se actualiza puntual (no pisa la posición) y la audita el trigger', async () => {
    const d = await distribuidora();
    const rol = await seedRol(RoleType.DELIVERY);
    const u = await ds.getRepository(User).save({
      email: 'cal@test.local',
      roleId: rol.roleId,
    } as Partial<User>);
    const chofer = await ds.getRepository(Delivery).save({
      distributorId: d.distributorId,
      userId: u.userId,
      calification: 3,
    } as Partial<Delivery>);
    // la posición nueva llega mientras se recalcula la calificación
    await ds.query(
      `UPDATE delivery SET location = ST_SetSRID(ST_MakePoint(-58.4, -34.6), 4326) WHERE delivery_id = $1`,
      [chofer.deliveryId],
    );

    await env.app
      .get(DeliveryService)
      .updateCalificationByUserId(u.userId, 4.5);

    const [fila] = await ds.query<Array<{ calification: number; ok: boolean }>>(
      `SELECT calification, location IS NOT NULL AS ok FROM delivery WHERE delivery_id = $1`,
      [chofer.deliveryId],
    );
    expect(fila).toEqual({ calification: 4.5, ok: true });
    const todas = await auditorias('Delivery', chofer.deliveryId);
    const ultima = todas[todas.length - 1];
    expect(ultima.actionTypeId).toBe(AuditActionTypeId.UPDATE);
    expect(await detalles(ultima.auditId)).toEqual([
      expect.objectContaining({
        field: 'calification',
        oldValue: '3',
        newValue: '4.5',
      }),
    ]);
  });

  it('un insert por query builder sin id no escribe una Auditoria con record_id vacío', async () => {
    await ds
      .createQueryBuilder()
      .insert()
      .into(Role)
      .values({ type: 'por-qb' })
      .execute();
    expect(
      await ds.getRepository(Audit).count({ where: { recordId: '' } }),
    ).toBe(0);
  });

  describe('actor en escrituras sin transacción (F25)', () => {
    const enRequest = <T>(user: User, trabajo: () => Promise<T>) =>
      auditContext.run(
        { userId: user.userId, ip: '10.9.9.9', distributorId: null },
        trabajo,
      );

    it('update(), query builder y SQL crudo del request llevan al usuario; sin request queda el sistema; nada se filtra por el pool', async () => {
      const d = await distribuidora();
      const admin = await seedAdmin(RoleType.ADMIN, d.distributorId);
      const g = await garrafa(d.distributorId);
      const repo = ds.getRepository(GasCylinder);
      const modif = async () => {
        const todas = await auditorias('GasCylinder', g.gasCylinderId);
        return todas[todas.length - 1];
      };

      await enRequest(admin, () =>
        repo.update({ gasCylinderId: g.gasCylinderId }, { stock: 6 }),
      );
      expect(await modif()).toMatchObject({
        actionTypeId: AuditActionTypeId.UPDATE,
        userId: admin.userId,
        ip: '10.9.9.9',
        source: 'db',
      });

      await enRequest(admin, () =>
        repo
          .createQueryBuilder()
          .update()
          .set({ stock: 7 })
          .where('gas_cylinder_id = :id', { id: g.gasCylinderId })
          .execute(),
      );
      expect((await modif()).userId).toBe(admin.userId);

      await enRequest(admin, () =>
        ds.query(
          `UPDATE gas_cylinder SET stock = 8 WHERE gas_cylinder_id = $1`,
          [g.gasCylinderId],
        ),
      );
      expect((await modif()).userId).toBe(admin.userId);

      // Sin request (cron, script): usuario nulo, y la conexión del pool que
      // acaba de servir al request no arrastra su actor.
      for (let i = 0; i < 12; i++) {
        await ds.query(
          `UPDATE gas_cylinder SET stock = $2 WHERE gas_cylinder_id = $1`,
          [g.gasCylinderId, 20 + i],
        );
        expect((await modif()).userId).toBeNull();
      }
    });

    it('un cambio por save() deja un solo asiento (el subscriber ya no escribe)', async () => {
      const d = await distribuidora();
      const g = await garrafa(d.distributorId);
      expect(await auditorias('GasCylinder', g.gasCylinderId)).toHaveLength(1);
      g.stock = 9;
      await ds.getRepository(GasCylinder).save(g);
      expect(await auditorias('GasCylinder', g.gasCylinderId)).toHaveLength(2);
    });

    it('la entrada de un cambio de tipo de chofer queda con anterior y nuevo', async () => {
      const d = await distribuidora();
      const admin = await seedAdmin(RoleType.ADMIN, d.distributorId);
      const rol = await seedRol(RoleType.DELIVERY);
      const u = await ds.getRepository(User).save({
        email: 'tipo@test.local',
        roleId: rol.roleId,
      } as Partial<User>);
      const chofer = await ds.getRepository(Delivery).save({
        distributorId: d.distributorId,
        userId: u.userId,
        isAvailable: true,
      } as Partial<Delivery>);
      await enRequest(admin, () =>
        ds
          .getRepository(Delivery)
          .update({ deliveryId: chofer.deliveryId }, { isAvailable: false }),
      );
      const todas = await auditorias('Delivery', chofer.deliveryId);
      const ultima = todas[todas.length - 1];
      expect(ultima.userId).toBe(admin.userId);
      expect(await detalles(ultima.auditId)).toEqual([
        expect.objectContaining({
          field: 'isAvailable',
          oldValue: 'true',
          newValue: 'false',
        }),
      ]);
    });
  });

  describe('contexto del request', () => {
    it('el pedido creado por API registra al usuario y la IP del request', async () => {
      const { user, distributor, headers } = await sembrarClienteAutenticado(
        env.app,
      );
      const cil = await garrafa(distributor.distributorId);
      const dir = await ds.getRepository(UserAddress).save({
        userId: user.userId,
        street: 'Av. Test 123',
        city: 'CABA',
        latitude: '-34.6037',
        longitude: '-58.3816',
      } as Partial<UserAddress>);

      const res = await request(env.app.getHttpServer())
        .post('/orders')
        .set(headers)
        .send({
          customerId: user.userId,
          addressId: dir.addressId,
          paymentMethod: 'cash',
          items: [
            { gasCylinderId: cil.gasCylinderId, quantity: 2, unitPrice: 1000 },
          ],
        });
      expect(res.status).toBe(201);
      const orderId = (res.body as { orderId: string }).orderId;

      const [alta] = await auditorias('Order', orderId);
      expect(alta.actionTypeId).toBe(AuditActionTypeId.CREATE);
      expect(alta.userId).toBe(user.userId);
      expect(alta.ip).toMatch(/127\.0\.0\.1/);
      expect(alta.distributorId).toBe(distributor.distributorId);

      // el stock descontado en la misma transacción también quedó
      const modifs = await auditorias('GasCylinder', cil.gasCylinderId);
      const stock = (await detalles(modifs[modifs.length - 1].auditId)).find(
        (x) => x.field === 'stock',
      );
      expect(stock).toMatchObject({ oldValue: '5', newValue: '3' });
      expect(modifs[modifs.length - 1].userId).toBe(user.userId);
    });
  });

  describe('API de consulta', () => {
    it('lista con detalles, filtra y respeta el aislamiento de tenant', async () => {
      const dA = await distribuidora('A');
      const dB = await distribuidora('B');
      const gA = await garrafa(dA.distributorId);
      const gB = await garrafa(dB.distributorId);
      const adminA = await seedAdmin(RoleType.ADMIN, dA.distributorId);
      const superAdmin = await seedAdmin(RoleType.SUPER_ADMIN, null);

      const lista = await get(
        adminA,
        '/audit/entries?entity=GasCylinder',
      ).expect(200);
      const pagina = lista.body as Pagina;
      expect(pagina.total).toBe(1);
      expect(pagina.data[0]).toMatchObject({
        entity: 'GasCylinder',
        recordId: gA.gasCylinderId,
        actionType: { id: 1, name: 'Alta' },
        distributorId: dA.distributorId,
      });
      expect(pagina.data[0].details.length).toBeGreaterThan(3);
      expect(pagina.data[0].dateTime).toBeDefined();

      // el registro de otra distribuidora no se ve ni por id (404, no 403)
      const ajena = (await auditorias('GasCylinder', gB.gasCylinderId))[0];
      await get(adminA, `/audit/entries/${ajena.auditId}`).expect(404);
      await get(adminA, `/audit/entries?recordId=${gB.gasCylinderId}`)
        .expect(200)
        .expect((r) => expect((r.body as Pagina).total).toBe(0));

      // el super admin ve todo, o la que elige
      const todo = await get(superAdmin, '/audit/entries?entity=GasCylinder');
      expect((todo.body as Pagina).total).toBe(2);
      const soloB = await get(
        superAdmin,
        '/audit/entries?entity=GasCylinder',
        dB.slug,
      );
      expect((soloB.body as Pagina).data.map((e) => e.recordId)).toEqual([
        gB.gasCylinderId,
      ]);

      const una = await get(adminA, `/audit/entries/${pagina.data[0].auditId}`);
      expect(una.status).toBe(200);
      expect((una.body as Entrada).details).toHaveLength(
        pagina.data[0].details.length,
      );
    });

    it('el alta, la edición y la baja de un depósito quedan auditadas y el historial lo devuelve', async () => {
      const d = await distribuidora();
      const admin = await seedAdmin(RoleType.ADMIN, d.distributorId);
      const escribir = (metodo: 'post' | 'patch' | 'delete', url: string) =>
        request(env.app.getHttpServer())
          [metodo](url)
          .set('Authorization', `Bearer ${admin.email}`)
          .set('X-Client-Source', 'panel-app');

      // El primero es el predeterminado y no se da de baja.
      await escribir('post', '/warehouses')
        .send({ name: 'Central', code: 'CENTRAL' })
        .expect(201);
      const alta = await escribir('post', '/warehouses')
        .send({ name: 'Galpón Norte', code: 'NORTE' })
        .expect(201);
      const { warehouseId } = alta.body as { warehouseId: string };
      await escribir('patch', `/warehouses/${warehouseId}`)
        .send({ address: 'Ruta 9 km 12' })
        .expect(200);
      await escribir('delete', `/warehouses/${warehouseId}`).expect(200);

      const historial = await get(
        admin,
        `/audit/entries?entity=Warehouse&recordId=${warehouseId}`,
      ).expect(200);
      const pagina = historial.body as Pagina;
      expect(pagina.data.map((e) => e.actionType.name).sort()).toEqual([
        'Alta',
        'Baja lógica',
        'Modificación',
      ]);
      const edicion = pagina.data.find(
        (e) => e.actionType.name === 'Modificación',
      );
      expect(edicion?.details).toEqual([
        expect.objectContaining({
          field: 'address',
          oldValue: null,
          newValue: 'Ruta 9 km 12',
        }),
      ]);
      expect(pagina.data.every((e) => e.user?.userId === admin.userId)).toBe(
        true,
      );
    });

    it('filtra por tipo de acción, usuario y fechas, y pagina', async () => {
      const d = await distribuidora();
      const g = await garrafa(d.distributorId);
      const c = await ds
        .getRepository(GasCylinder)
        .findOneByOrFail({ gasCylinderId: g.gasCylinderId });
      c.stock = 1;
      await ds.getRepository(GasCylinder).save(c);
      const admin = await seedAdmin(RoleType.ADMIN, d.distributorId);

      const modif = await get(
        admin,
        `/audit/entries?actionType=2&recordId=${g.gasCylinderId}`,
      ).expect(200);
      expect((modif.body as Pagina).total).toBe(1);
      expect((modif.body as Pagina).data[0].details[0].field).toBe('stock');

      const futuro = new Date(Date.now() + 3_600_000).toISOString();
      await get(admin, `/audit/entries?from=${futuro}`)
        .expect(200)
        .expect((r) => expect((r.body as Pagina).total).toBe(0));
      await get(admin, `/audit/entries?userId=${randomUUID()}`)
        .expect(200)
        .expect((r) => expect((r.body as Pagina).total).toBe(0));
      const pag = await get(admin, '/audit/entries?limit=1&page=2').expect(200);
      expect((pag.body as Pagina).data).toHaveLength(1);
      expect((pag.body as Pagina).total).toBeGreaterThan(1);
      await get(admin, '/audit/entries?limit=999').expect(400);
    });

    it('v2: origin distingue usuario, sistema (la API) y directo (otra aplicación), y trae las columnas nuevas; la v1 no cambia', async () => {
      const d = await distribuidora();
      const admin = await seedAdmin(RoleType.ADMIN, d.distributorId);
      const g = await garrafa(d.distributorId);
      const repo = ds.getRepository(GasCylinder);
      // usuario: update() dentro de un request
      await auditContext.run(
        { userId: admin.userId, ip: '10.1.1.1', distributorId: null },
        () => repo.update({ gasCylinderId: g.gasCylinderId }, { stock: 11 }),
      );
      // sistema: sin request, por la conexión de la API
      await repo.update({ gasCylinderId: g.gasCylinderId }, { stock: 12 });
      // directo: otra aplicación (psql, un script) escribe en la base
      const qr = ds.createQueryRunner();
      try {
        await qr.query(`SET application_name = 'psql-manual'`);
        await qr.query(
          `UPDATE gas_cylinder SET stock = 13 WHERE gas_cylinder_id = $1`,
          [g.gasCylinderId],
        );
        await qr.query(`RESET application_name`);
      } finally {
        await qr.release();
      }

      type Entrada = {
        origin: string;
        source: string;
        tableName: string;
        dbUser: string;
        appName: string;
        userId: string | null;
        details: Array<{ field: string; newValue: string }>;
      };
      const v2 = async (origin: string) => {
        const res = await get(
          admin,
          `/v2/audit/entries?entity=GasCylinder&recordId=${g.gasCylinderId}&actionType=2&origin=${origin}`,
          d.distributorId,
        ).expect(200);
        return (res.body as { data: Entrada[] }).data;
      };
      const [delUsuario] = await v2('user');
      expect(delUsuario).toMatchObject({
        origin: 'user',
        source: 'db',
        tableName: 'gas_cylinder',
        appName: 'splg-api',
        userId: admin.userId,
      });
      const [delSistema] = await v2('system');
      expect(delSistema).toMatchObject({
        origin: 'system',
        appName: 'splg-api',
        userId: null,
      });
      const [directo] = await v2('direct');
      expect(directo).toMatchObject({
        origin: 'direct',
        appName: 'psql-manual',
        userId: null,
      });
      expect(directo.details).toEqual([
        expect.objectContaining({ field: 'stock', newValue: '13' }),
      ]);

      // v1: mismos asientos, sin los campos nuevos
      const v1 = await get(
        admin,
        `/v1/audit/entries?entity=GasCylinder&recordId=${g.gasCylinderId}`,
        d.distributorId,
      ).expect(200);
      const filasV1 = (v1.body as { data: Array<Record<string, unknown>> })
        .data;
      expect(filasV1.length).toBeGreaterThanOrEqual(4);
      for (const f of filasV1) {
        expect(f).not.toHaveProperty('origin');
        expect(f).not.toHaveProperty('appName');
      }
      // detalle y catálogo de la v2
      const uno = await get(
        admin,
        `/v2/audit/entries/${(await auditorias('GasCylinder', g.gasCylinderId))[0].auditId}`,
        d.distributorId,
      ).expect(200);
      expect(uno.body).toHaveProperty('origin');
      const tipos = await get(admin, '/v2/audit/action-types').expect(200);
      expect((tipos.body as unknown[]).length).toBe(8);
    });

    it('el catálogo de acciones y la protección por rol', async () => {
      const d = await distribuidora();
      const admin = await seedAdmin(RoleType.ADMIN, d.distributorId);
      const { headers } = await sembrarClienteAutenticado(env.app);

      const res = await get(admin, '/audit/action-types').expect(200);
      expect(res.body).toEqual([
        { id: 1, name: 'Alta' },
        { id: 2, name: 'Modificación' },
        { id: 3, name: 'Baja lógica' },
        { id: 4, name: 'Reactivación' },
        { id: 5, name: 'Baja física' },
        { id: 6, name: 'Ingreso' },
        { id: 7, name: 'Ingreso fallido' },
        { id: 8, name: 'Salida' },
      ]);
      await request(env.app.getHttpServer())
        .get('/audit/entries')
        .set(headers)
        .expect(403);
      await request(env.app.getHttpServer()).get('/audit/entries').expect(401);
    });
  });
});
