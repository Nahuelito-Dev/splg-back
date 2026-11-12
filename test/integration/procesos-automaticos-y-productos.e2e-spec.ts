/**
 * C-07 contra la API con Postgres y Redis reales:
 *  - CU-172: parámetros de los procesos automáticos (`/module-config/:proceso`).
 *  - CU-151: el barrido que desactiva las zonas de cobertura vencidas.
 *  - CU-268 y CU-269: productos dados de baja (listado y reactivación).
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
  cuitDePrueba,
} from './setup/test-env';
import { MENSAJE_FALTA_DISTRIBUIDORA } from '../../src/common/decorators/current-distributor.decorator';
import { Admin } from '../../src/admin/entities/admin.entity';
import { AdminGateway } from '../../src/gateways/admin.gateway';
import {
  CoverageZoneExpiryCron,
  EVENTO_SIN_ZONAS_ACTIVAS,
} from '../../src/coverage-zone/coverage-zone-expiry.cron';
import { CoverageZone } from '../../src/coverage-zone/entities/coverage-zone.entity';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Delivery } from '../../src/delivery/entities/delivery.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { ProcessConfigService } from '../../src/distributor/process-config.service';
import { ConfigurableProcess } from '../../src/distributor/entities/module-config.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { GasCylinderPromotion } from '../../src/gascylinder/entities/gascylinder-promotion.entity';
import { RedisService } from '../../src/redis/redis.service';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { etiquetaDeCampo } from '../../src/common/validation/etiquetas';

type Headers = Record<string, string>;

const PROCESOS = [
  'fleet_planner',
  'repurchase',
  'route_batching',
  'route_planning',
  'cylinder_recovery',
  'document_reading',
];

describe('Procesos automáticos, zonas vencidas y productos inactivos (C-07, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let seq = 0;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => request(env.app.getHttpServer());

  async function usuario(
    tipo: 'customer' | 'admin' | 'super_admin' | 'delivery',
  ) {
    seq += 1;
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: tipo } })) ??
      (await roles.save({ type: tipo } as Partial<Role>));
    const email = `${tipo}.${seq}.${randomUUID().slice(0, 6)}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: `${tipo} ${seq}`,
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>);
    return { user, email };
  }

  const h = (email: string, fuente: string, extra: Headers = {}): Headers => ({
    Authorization: `Bearer ${email}`,
    'X-Client-Source': fuente,
    ...extra,
  });

  async function distribuidora(): Promise<Distributor> {
    seq += 1;
    return ds.getRepository(Distributor).save({
      name: `Dist ${seq}`,
      slug: `dist-${seq}-${randomUUID().slice(0, 4)}`,
      legalName: 'Test SRL',
      taxId: cuitDePrueba(),
      email: `d${seq}${Date.now()}@test.local`,
      phone: '+540000000000',
    } as Partial<Distributor>);
  }

  async function adminDe(d: Distributor) {
    const a = await usuario('admin');
    await ds.getRepository(Admin).save({
      userId: a.user.userId,
      distributorId: d.distributorId,
    } as Partial<Admin>);
    return { userId: a.user.userId, headers: h(a.email, 'panel-app') };
  }

  async function escenario() {
    const dA = await distribuidora();
    const dB = await distribuidora();
    const adminA = await adminDe(dA);
    const adminB = await adminDe(dB);
    const sup = await usuario('super_admin');
    const chofer = await usuario('delivery');
    await ds.getRepository(Delivery).save({
      userId: chofer.user.userId,
      distributorId: dA.distributorId,
      validated: true,
      isEnabled: true,
    } as Partial<Delivery>);
    const cliente = await usuario('customer');
    await ds.getRepository(Customer).save({
      userId: cliente.user.userId,
      notificationToken: 'fake',
    } as Partial<Customer>);
    return {
      dA,
      dB,
      adminA,
      adminB,
      sup: h(sup.email, 'panel-app'),
      chofer: h(chofer.email, 'driver-app'),
      cliente: h(cliente.email, 'customer-app'),
    };
  }
  describe('CU-172 · parámetros de un proceso automático', () => {
    it('lista los procesos configurables con su esquema y los valores por omisión', async () => {
      const e = await escenario();
      const res = await http()
        .get('/module-config/processes')
        .set(e.adminA.headers)
        .expect(200);
      const lista = res.body as Array<{
        process: string;
        isDefault: boolean;
        fields: Array<{ key: string; default: number }>;
        params: Record<string, number>;
        updatedAt: string | null;
      }>;
      expect(lista.map((p) => p.process).sort()).toEqual([...PROCESOS].sort());
      for (const p of lista) {
        expect(p.isDefault).toBe(true);
        expect(p.updatedAt).toBeNull();
        for (const f of p.fields) expect(p.params[f.key]).toBe(f.default);
      }
    });

    it('PUT válido guarda con quién lo hizo, GET lo refleja y los procesos consumidores lo leen', async () => {
      const e = await escenario();
      const put = await http()
        .put('/module-config/repurchase')
        .set(e.adminA.headers)
        .send({ anticipationDays: 5, invitationTtlHours: 48 })
        .expect(200);
      expect(put.body).toMatchObject({
        process: 'repurchase',
        isDefault: false,
        updatedByUserId: e.adminA.userId,
        params: {
          anticipationDays: 5,
          invitationTtlHours: 48,
          minOrders: 3,
          minIntervalDays: 7,
          runHour: 9,
        },
      });

      const get = await http()
        .get('/module-config/repurchase')
        .set(e.adminA.headers)
        .expect(200);
      expect(
        (get.body as { params: Record<string, number> }).params,
      ).toMatchObject({ anticipationDays: 5, invitationTtlHours: 48 });

      const servicio = env.app.get(ProcessConfigService);
      const leidos = await servicio.obtener(
        e.dA.distributorId,
        ConfigurableProcess.REPURCHASE,
      );
      expect(leidos.anticipationDays).toBe(5);
    });

    it('guardar un proceso no toca los demás ni la fila del despacho', async () => {
      const e = await escenario();
      await http()
        .put('/module-config/dispatch')
        .set(e.adminA.headers)
        .send({ offerTtlSeconds: 90 })
        .expect(200);
      await http()
        .put('/module-config/cylinder_recovery')
        .set(e.adminA.headers)
        .send({ toleranceDays: 40 })
        .expect(200);
      const despacho = await http()
        .get('/module-config/dispatch')
        .set(e.adminA.headers)
        .expect(200);
      expect(
        (despacho.body as { offerTtlSeconds: number }).offerTtlSeconds,
      ).toBe(90);
      const recompra = await http()
        .get('/module-config/repurchase')
        .set(e.adminA.headers)
        .expect(200);
      expect((recompra.body as { isDefault: boolean }).isDefault).toBe(true);
    });

    it('un cuerpo vacío restablece los valores por omisión', async () => {
      const e = await escenario();
      await http()
        .put('/module-config/route_batching')
        .set(e.adminA.headers)
        .send({ maxBatchSize: 10 })
        .expect(200);
      const res = await http()
        .put('/module-config/route_batching')
        .set(e.adminA.headers)
        .send({})
        .expect(200);
      expect(res.body).toMatchObject({
        isDefault: true,
        params: { maxBatchSize: 4 },
      });
    });

    it.each([
      [
        'fuera de rango',
        'repurchase',
        { anticipationDays: 31 },
        'anticipationDays',
      ],
      ['decimal en un entero', 'repurchase', { minOrders: 2.5 }, 'minOrders'],
      ['de otro tipo', 'repurchase', { minOrders: '3' }, 'minOrders'],
      ['campo desconocido', 'repurchase', { invento: 1 }, 'invento'],
      [
        'campo de otro proceso',
        'cylinder_recovery',
        { anticipationDays: 3 },
        'anticipationDays',
      ],
    ])(
      'rechaza un parámetro inválido (%s) con 400 y el campo, sin guardar',
      async (_c, proceso, cuerpo, campo) => {
        const e = await escenario();
        const res = await http()
          .put(`/module-config/${proceso}`)
          .set(e.adminA.headers)
          .send(cuerpo)
          .expect(400);
        expect(JSON.stringify(res.body)).toContain(
          etiquetaDeCampo(campo) ?? 'Se envió un dato que no corresponde',
        );
        expect(JSON.stringify(res.body)).not.toContain(campo);
        const despues = await http()
          .get(`/module-config/${proceso}`)
          .set(e.adminA.headers)
          .expect(200);
        expect((despues.body as { isDefault: boolean }).isDefault).toBe(true);
      },
    );

    it('un proceso que no es configurable es 404 (también stock_control)', async () => {
      const e = await escenario();
      for (const proceso of ['inventado', 'stock_control']) {
        await http()
          .get(`/module-config/${proceso}`)
          .set(e.adminA.headers)
          .expect(404);
        await http()
          .put(`/module-config/${proceso}`)
          .set(e.adminA.headers)
          .send({})
          .expect(404);
      }
    });

    it('aislamiento: lo que guarda una distribuidora no lo ve la otra', async () => {
      const e = await escenario();
      await http()
        .put('/module-config/cylinder_recovery')
        .set(e.adminA.headers)
        .send({ toleranceDays: 60 })
        .expect(200);
      const b = await http()
        .get('/module-config/cylinder_recovery')
        .set(e.adminB.headers)
        .expect(200);
      expect(b.body).toMatchObject({
        isDefault: true,
        params: { toleranceDays: 30 },
        updatedByUserId: null,
      });
      const filas: unknown[] = await ds.query(
        `SELECT distributor_id FROM module_config WHERE module = 'cylinder_recovery'`,
      );
      expect(filas).toEqual([{ distributor_id: e.dA.distributorId }]);
    });

    it('el super admin necesita X-Distributor; chofer y cliente reciben 403', async () => {
      const e = await escenario();
      const sin = await http()
        .get('/module-config/repurchase')
        .set(e.sup)
        .expect(400);
      expect(JSON.stringify(sin.body)).toContain(MENSAJE_FALTA_DISTRIBUIDORA);
      await http()
        .put('/module-config/repurchase')
        .set(e.sup)
        .send({ minOrders: 4 })
        .expect(400);
      await http()
        .put('/module-config/repurchase')
        .set({ ...e.sup, 'X-Distributor': e.dB.slug })
        .send({ minOrders: 4 })
        .expect(200);
      expect(
        await env.app
          .get(ProcessConfigService)
          .obtener(e.dB.distributorId, ConfigurableProcess.REPURCHASE),
      ).toMatchObject({ minOrders: 4 });
      await http().get('/module-config/repurchase').set(e.chofer).expect(403);
      await http().get('/module-config/processes').set(e.cliente).expect(403);
      await http()
        .put('/module-config/repurchase')
        .set(e.cliente)
        .send({})
        .expect(403);
    });
  });

  describe('CU-151 · zonas de cobertura vencidas', () => {
    const POLIGONO = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-58.4, -34.6],
          [-58.3, -34.6],
          [-58.3, -34.7],
          [-58.4, -34.6],
        ],
      ],
    };
    const ahora = Date.now();
    const hace = (ms: number) => new Date(ahora - ms);
    const dentroDe = (ms: number) => new Date(ahora + ms);

    async function zona(
      d: Distributor,
      nombre: string,
      over: Partial<CoverageZone> = {},
    ): Promise<CoverageZone> {
      return ds.getRepository(CoverageZone).save({
        distributorId: d.distributorId,
        name: nombre,
        area: POLIGONO,
        surchargeValue: 15,
        isActive: true,
        ...over,
      } as Partial<CoverageZone>) as Promise<CoverageZone>;
    }

    const activa = async (id: string) =>
      (
        await ds
          .getRepository(CoverageZone)
          .findOneByOrFail({ coverageZoneId: id })
      ).isActive;

    it('desactiva sólo las vencidas, de todas las distribuidoras, sin tocar polígono ni recargo', async () => {
      const e = await escenario();
      const vencidaA = await zona(e.dA, 'vencida A', {
        validUntil: hace(60_000),
      });
      const vencidaB = await zona(e.dB, 'vencida B', {
        validUntil: hace(3_600_000),
      });
      const vigente = await zona(e.dA, 'vigente', {
        validUntil: dentroDe(3_600_000),
      });
      const sinFin = await zona(e.dA, 'sin fin');
      const yaInactiva = await zona(e.dA, 'inactiva', {
        isActive: false,
        validUntil: hace(60_000),
      });
      const borrada = await zona(e.dA, 'borrada', {
        validUntil: hace(60_000),
        deletedAt: new Date(),
      });

      const cron = env.app.get(CoverageZoneExpiryCron);
      expect(await cron.barrer()).toBe(2);

      expect(await activa(vencidaA.coverageZoneId)).toBe(false);
      expect(await activa(vencidaB.coverageZoneId)).toBe(false);
      expect(await activa(vigente.coverageZoneId)).toBe(true);
      expect(await activa(sinFin.coverageZoneId)).toBe(true);
      expect(await activa(yaInactiva.coverageZoneId)).toBe(false);
      const filaBorrada = await ds.getRepository(CoverageZone).findOne({
        where: { coverageZoneId: borrada.coverageZoneId },
        withDeleted: true,
      });
      expect(filaBorrada?.isActive).toBe(true);

      // No se borra ni se toca el polígono ni el recargo.
      const conservada = await ds
        .getRepository(CoverageZone)
        .findOneByOrFail({ coverageZoneId: vencidaA.coverageZoneId });
      expect(conservada.deletedAt).toBeNull();
      expect(conservada.surchargeValue).toBe(15);
      expect(conservada.area.coordinates[0]).toHaveLength(4);
      expect(conservada.validUntil?.getTime()).toBe(
        vencidaA.validUntil?.getTime(),
      );

      // Un segundo barrido ya no tiene nada que hacer.
      expect(await cron.barrer()).toBe(0);
    });

    it('el listado del panel deja de mostrar la zona vencida (y con includeInactive la muestra apagada)', async () => {
      const e = await escenario();
      const vencida = await zona(e.dA, 'vencida', { validUntil: hace(60_000) });
      await env.app.get(CoverageZoneExpiryCron).barrer();

      const activas = await http()
        .get('/coverage-zones')
        .set(e.adminA.headers)
        .expect(200);
      expect(
        (activas.body as Array<{ coverage_zone_id: string }>).map(
          (z) => z.coverage_zone_id,
        ),
      ).not.toContain(vencida.coverageZoneId);

      const todas = await http()
        .get('/coverage-zones?includeInactive=true')
        .set(e.adminA.headers)
        .expect(200);
      expect(
        (
          todas.body as Array<{ coverage_zone_id: string; isActive: boolean }>
        ).find((z) => z.coverage_zone_id === vencida.coverageZoneId)?.isActive,
      ).toBe(false);
    });

    it('deja la auditoría de cada zona apagada y avisa a los admins sólo de la distribuidora que se quedó sin zonas activas', async () => {
      const e = await escenario();
      const ultimaA = await zona(e.dA, 'única de A', {
        validUntil: hace(60_000),
      });
      const venceB = await zona(e.dB, 'vence B', { validUntil: hace(60_000) });
      await zona(e.dB, 'sigue B');
      const aviso = jest.spyOn(env.app.get(AdminGateway), 'notifyAdmins');

      await env.app.get(CoverageZoneExpiryCron).barrer();

      expect(aviso).toHaveBeenCalledTimes(1);
      expect(aviso).toHaveBeenCalledWith(
        EVENTO_SIN_ZONAS_ACTIVAS,
        expect.objectContaining({
          distributorId: e.dA.distributorId,
          zoneIds: [ultimaA.coverageZoneId],
        }),
        e.dA.distributorId,
      );
      aviso.mockRestore();

      const asientos: Array<{ record_id: string; new_value: string }> =
        await ds.query(
          `SELECT a.record_id, d.new_value FROM audit a
             JOIN audit_detail d ON d.audit_id = a.audit_id
            WHERE a.entity = 'CoverageZone' AND d.field = 'isActive' AND d.new_value = 'false' AND d.old_value = 'true'`,
        );
      expect(asientos.map((x) => x.record_id).sort()).toEqual(
        [ultimaA.coverageZoneId, venceB.coverageZoneId].sort(),
      );
      expect(asientos.every((x) => x.new_value === 'false')).toBe(true);
    });

    it('no deja crear ni reactivar una zona con la fecha de fin vencida (400)', async () => {
      const e = await escenario();
      const poligono = POLIGONO.coordinates[0];
      const nueva = await http()
        .post('/coverage-zones')
        .set(e.adminA.headers)
        .send({
          name: 'Vieja',
          polygon: poligono,
          validUntil: '2020-01-01T00:00:00Z',
        })
        .expect(400);
      expect(JSON.stringify(nueva.body)).toContain('La fecha de fin ya pasó');

      const apagada = await zona(e.dA, 'apagada', {
        isActive: false,
        validUntil: hace(60_000),
      });
      await http()
        .patch(`/coverage-zones/${apagada.coverageZoneId}`)
        .set(e.adminA.headers)
        .send({ isActive: true })
        .expect(400);
      expect(await activa(apagada.coverageZoneId)).toBe(false);
      await http()
        .patch(`/coverage-zones/${apagada.coverageZoneId}`)
        .set(e.adminA.headers)
        .send({
          isActive: true,
          validUntil: new Date(ahora + 86_400_000).toISOString(),
        })
        .expect(200);
      expect(await activa(apagada.coverageZoneId)).toBe(true);
    });

    it('con el cerrojo tomado por otra instancia el tic no barre; sin cerrojo, sí', async () => {
      const e = await escenario();
      const vencida = await zona(e.dA, 'vencida', { validUntil: hace(60_000) });
      const cron = env.app.get(CoverageZoneExpiryCron);
      const redis = env.app.get(RedisService);

      await redis.withLock(CoverageZoneExpiryCron.CERROJO, 10_000, async () => {
        await cron.desactivarVencidas();
        expect(await activa(vencida.coverageZoneId)).toBe(true);
      });

      await cron.desactivarVencidas();
      expect(await activa(vencida.coverageZoneId)).toBe(false);
    });

    it('si el barrido falla, el cerrojo se libera y la ejecución siguiente lo toma', async () => {
      const e = await escenario();
      const vencida = await zona(e.dA, 'vencida', { validUntil: hace(60_000) });
      const cron = env.app.get(CoverageZoneExpiryCron);
      const barrer = jest
        .spyOn(cron, 'barrer')
        .mockRejectedValueOnce(new Error('base caída'));
      await cron.desactivarVencidas();
      expect(await activa(vencida.coverageZoneId)).toBe(true);
      barrer.mockRestore();

      await cron.desactivarVencidas();
      expect(await activa(vencida.coverageZoneId)).toBe(false);
    });
  });

  describe('CU-268 y CU-269 · productos dados de baja', () => {
    async function producto(d: Distributor, type: string, stock = 20) {
      return ds.getRepository(GasCylinder).save({
        distributorId: d.distributorId,
        type,
        weight: 10,
        price: 1000,
        stock,
        isActive: true,
      } as Partial<GasCylinder>);
    }

    const ids = (cuerpo: unknown) =>
      (
        cuerpo as { gasCylinders: Array<{ gas_cylinder_id: string }> }
      ).gasCylinders.map((g) => g.gas_cylinder_id);

    it('la baja lo saca del catálogo y lo muestra en inactivos; reactivar lo devuelve con stock y promociones intactos', async () => {
      const e = await escenario();
      const creado = await http()
        .post('/gascylinder')
        .set(e.adminA.headers)
        .send({
          type: '45kg',
          weight: 45,
          price: 5000,
          stock: 12,
          promotions: [{ quantity: 3, discountPercentage: 10 }],
        })
        .expect(201);
      const id = (creado.body as { gas_cylinder_id: string }).gas_cylinder_id;
      const otro = await producto(e.dA, '10kg');

      await http()
        .delete(`/gascylinder/${id}`)
        .set(e.adminA.headers)
        .expect(200);

      const catalogo = await http()
        .get('/gascylinder')
        .set(e.adminA.headers)
        .expect(200);
      expect(ids(catalogo.body)).not.toContain(id);
      expect(ids(catalogo.body)).toContain(otro.gasCylinderId);

      const inactivos = await http()
        .get('/gascylinder/inactive')
        .set(e.adminA.headers)
        .expect(200);
      expect(ids(inactivos.body)).toEqual([id]);
      expect(inactivos.body).toMatchObject({ total: 1, limit: 10, offset: 0 });

      const reactivado = await http()
        .patch(`/gascylinder/${id}/reactivate`)
        .set(e.adminA.headers)
        .expect(200);
      const asiento: Array<{ new_value: string }> = await ds.query(
        `SELECT d.new_value FROM audit a JOIN audit_detail d ON d.audit_id = a.audit_id
          WHERE a.entity = 'GasCylinder' AND a.record_id = $1 AND d.field = 'isActive'
          ORDER BY a.created_at DESC`,
        [id],
      );
      expect(asiento[0]?.new_value).toBe('true');
      expect(reactivado.body).toMatchObject({
        gas_cylinder_id: id,
        isActive: true,
        stock: 12,
      });
      expect(
        (reactivado.body as { promotions: unknown[] }).promotions,
      ).toHaveLength(1);
      expect(
        await ds
          .getRepository(GasCylinderPromotion)
          .count({ where: { gasCylinderId: id } }),
      ).toBe(1);

      const catalogo2 = await http()
        .get('/gascylinder')
        .set(e.adminA.headers)
        .expect(200);
      expect(ids(catalogo2.body)).toContain(id);
      const inactivos2 = await http()
        .get('/gascylinder/inactive')
        .set(e.adminA.headers)
        .expect(200);
      expect(ids(inactivos2.body)).toEqual([]);
    });

    it('reactivar uno que ya estaba activo responde igual, sin cambios', async () => {
      const e = await escenario();
      const p = await producto(e.dA, '15kg', 7);
      const res = await http()
        .patch(`/gascylinder/${p.gasCylinderId}/reactivate`)
        .set(e.adminA.headers)
        .expect(200);
      expect(res.body).toMatchObject({ isActive: true, stock: 7 });
    });

    it('aislamiento: otra distribuidora no ve el inactivo ni puede reactivarlo (404), y no se cambia', async () => {
      const e = await escenario();
      const p = await producto(e.dA, '10kg');
      await http()
        .delete(`/gascylinder/${p.gasCylinderId}`)
        .set(e.adminA.headers)
        .expect(200);

      const deB = await http()
        .get('/gascylinder/inactive')
        .set(e.adminB.headers)
        .expect(200);
      expect(ids(deB.body)).toEqual([]);

      await http()
        .patch(`/gascylinder/${p.gasCylinderId}/reactivate`)
        .set(e.adminB.headers)
        .expect(404);
      await http()
        .patch(`/gascylinder/${randomUUID()}/reactivate`)
        .set(e.adminA.headers)
        .expect(404);
      expect(
        (
          await ds
            .getRepository(GasCylinder)
            .findOneByOrFail({ gasCylinderId: p.gasCylinderId })
        ).isActive,
      ).toBe(false);
    });

    it('la edición rechaza isActive: reactivar es una operación propia', async () => {
      const e = await escenario();
      const p = await producto(e.dA, '10kg');
      await http()
        .delete(`/gascylinder/${p.gasCylinderId}`)
        .set(e.adminA.headers)
        .expect(200);
      await http()
        .patch(`/gascylinder/${p.gasCylinderId}`)
        .set(e.adminA.headers)
        .send({ isActive: true })
        .expect(400);
      expect(
        (
          await ds
            .getRepository(GasCylinder)
            .findOneByOrFail({ gasCylinderId: p.gasCylinderId })
        ).isActive,
      ).toBe(false);
    });

    it('pagina y busca por texto en los inactivos', async () => {
      const e = await escenario();
      for (const t of ['10kg', '15kg', '45kg']) {
        const p = await producto(e.dA, t);
        await http()
          .delete(`/gascylinder/${p.gasCylinderId}`)
          .set(e.adminA.headers)
          .expect(200);
      }
      const pagina = await http()
        .get('/gascylinder/inactive?limit=2&offset=0')
        .set(e.adminA.headers)
        .expect(200);
      expect(ids(pagina.body)).toHaveLength(2);
      expect(pagina.body).toMatchObject({ total: 3, limit: 2 });
      const buscado = await http()
        .get('/gascylinder/inactive?term=45')
        .set(e.adminA.headers)
        .expect(200);
      expect(
        (
          buscado.body as { gasCylinders: Array<{ type: string }> }
        ).gasCylinders.map((g) => g.type),
      ).toEqual(['45kg']);
    });

    it('el super admin necesita X-Distributor; el cliente y el chofer reciben 403', async () => {
      const e = await escenario();
      const p = await producto(e.dA, '10kg');
      const sin = await http()
        .get('/gascylinder/inactive')
        .set(e.sup)
        .expect(400);
      expect(JSON.stringify(sin.body)).toContain(MENSAJE_FALTA_DISTRIBUIDORA);
      await http()
        .patch(`/gascylinder/${p.gasCylinderId}/reactivate`)
        .set(e.sup)
        .expect(400);
      await http()
        .get('/gascylinder/inactive')
        .set({ ...e.sup, 'X-Distributor': e.dA.slug })
        .expect(200);
      await http().get('/gascylinder/inactive').set(e.cliente).expect(403);
      await http()
        .patch(`/gascylinder/${p.gasCylinderId}/reactivate`)
        .set(e.chofer)
        .expect(403);
    });
  });
});
