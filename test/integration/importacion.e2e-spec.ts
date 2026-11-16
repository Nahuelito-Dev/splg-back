/**
 * Importación masiva (API v2) contra la app con Postgres y Redis reales:
 * plantilla, vista previa con errores por fila, confirmación todo-o-nada con
 * una transacción de verdad, idempotencia y aislamiento entre distribuidoras.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Workbook } from 'exceljs';
import { Readable } from 'stream';
import { Admin } from '../../src/admin/entities/admin.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { ImportJob } from '../../src/import/entities/import-job.entity';
import { Role } from '../../src/role/entities/role.entity';
import { WarehouseService } from '../../src/stock/application/warehouse.service';
import { User } from '../../src/users/entities/user.entity';
import {
  TestEnv,
  createTestApp,
  sembrarClienteAutenticado,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';

type Headers = Record<string, string>;
const cuerpo = <T>(res: { body: unknown }): T => res.body as T;

interface Vista {
  importId: string;
  estado: string;
  total: number;
  validas: number;
  errores: Array<{ fila: number; columna: string; mensaje: string }>;
  vistaPrevia: Array<{ fila: number; datos: Record<string, unknown> }>;
}
interface Confirmada {
  importId: string;
  estado: string;
  resumen: Record<string, number>;
  yaConfirmada: boolean;
}
interface Mensaje {
  message: string;
}

describe('Importación masiva (e2e)', () => {
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

  const http = () => request(env.app.getHttpServer());

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedDistribuidora() {
    const sufijo = randomUUID().slice(0, 8);
    const distribuidora = (await ds.getRepository(Distributor).save({
      name: `Distribuidora ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
    const deposito = await env.app
      .get(WarehouseService)
      .asegurarPredeterminado(distribuidora.distributorId);
    const email = `admin.${sufijo}@splg.local`;
    const user = (await ds.getRepository(User).save({
      email,
      fullName: 'Admin Test',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol('admin')).roleId,
    } as Partial<User>)) as User;
    await ds.getRepository(Admin).save({
      userId: user.userId,
      distributorId: distribuidora.distributorId,
    } as Partial<Admin>);
    const headers: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'panel-app',
    };
    return {
      distributorId: distribuidora.distributorId,
      warehouseId: deposito.warehouse.warehouseId,
      locationId: deposito.locationId,
      codigoDeposito: deposito.warehouse.code,
      headers,
    };
  }

  const subir = (
    e: { headers: Headers },
    recurso: string,
    texto: string,
    nombre = 'carga.csv',
  ) =>
    http()
      .post(`/v2/imports/${recurso}/preview`)
      .set(e.headers)
      .attach('file', Buffer.from(texto, 'utf-8'), nombre);

  const vista = async (
    e: { headers: Headers },
    recurso: string,
    texto: string,
  ) => cuerpo<Vista>(await subir(e, recurso, texto).expect(201));

  const confirmar = (e: { headers: Headers }, importId: string) =>
    http().post(`/v2/imports/${importId}/confirm`).set(e.headers);

  const garrafas = (distributorId: string) =>
    ds.getRepository(GasCylinder).find({
      where: { distributorId },
      order: { type: 'ASC' },
    });

  const saldo = async (
    locationId: string,
    gasCylinderId: string,
    condition: string,
  ) => {
    const [fila] = await ds.query<Array<{ quantity: number }>>(
      `SELECT quantity FROM stock_balance WHERE location_id = $1 AND gas_cylinder_id = $2 AND condition = $3`,
      [locationId, gasCylinderId, condition],
    );
    return fila?.quantity ?? 0;
  };

  describe('plantilla', () => {
    it('xlsx y csv de cada recurso, y se pueden volver a subir tal cual', async () => {
      const e = await seedDistribuidora();
      for (const recurso of ['garrafas', 'precios', 'stock', 'proveedores']) {
        const csv = await http()
          .get(`/v2/imports/${recurso}/template?format=csv`)
          .set(e.headers)
          .expect(200);
        expect(csv.headers['content-disposition']).toContain(
          `plantilla-${recurso}.csv`,
        );
        const xlsx = await http()
          .get(`/v2/imports/${recurso}/template`)
          .set(e.headers)
          .buffer(true)
          .parse((r, cb) => {
            const partes: Buffer[] = [];
            r.on('data', (c: Buffer) => partes.push(c));
            r.on('end', () => cb(null, Buffer.concat(partes)));
          })
          .expect(200);
        const libro = new Workbook();
        await libro.xlsx.read(Readable.from([xlsx.body as Buffer]));
        expect(libro.worksheets[0].rowCount).toBe(2);
      }
    });

    it('la plantilla de garrafas, con su fila de ejemplo, es una vista previa válida', async () => {
      const e = await seedDistribuidora();
      const plantilla = await http()
        .get('/v2/imports/garrafas/template?format=csv')
        .set(e.headers)
        .expect(200);
      const v = cuerpo<Vista>(
        await subir(e, 'garrafas', plantilla.text).expect(201),
      );
      expect(v).toMatchObject({ estado: 'pending', total: 1, validas: 1 });
    });

    it('un cliente (rol sin permiso) es 403 en los tres endpoints', async () => {
      const { headers } = await sembrarClienteAutenticado(env.app);
      await http()
        .get('/v2/imports/garrafas/template')
        .set(headers)
        .expect(403);
      await http()
        .post('/v2/imports/garrafas/preview')
        .set(headers)
        .attach('file', Buffer.from('Tipo\n1\n'), 'a.csv')
        .expect(403);
      await http()
        .post(`/v2/imports/${randomUUID()}/confirm`)
        .set(headers)
        .expect(403);
    });
  });

  describe('garrafas', () => {
    const CSV_OK =
      'Tipo;Peso (kg);Precio;Stock inicial;Descripción\n' +
      '10 kg;10;12500,50;5;Garrafa chica\n' +
      '15 kg;15;"18.000,00";;\n' +
      '45 kg;45;40000;2;\n';

    it('la vista previa valida todo y no escribe nada del negocio', async () => {
      const e = await seedDistribuidora();
      const v = await vista(e, 'garrafas', CSV_OK);

      expect(v).toMatchObject({
        estado: 'pending',
        total: 3,
        validas: 3,
        errores: [],
      });
      expect(v.vistaPrevia[1].datos).toMatchObject({
        type: '15 kg',
        price: 18000,
      });
      expect(await garrafas(e.distributorId)).toEqual([]);
      expect(await ds.getRepository(ImportJob).count()).toBe(1);
    });

    it('devuelve los errores por fila y columna, con las reglas del alta unitaria', async () => {
      const e = await seedDistribuidora();
      await ds.getRepository(GasCylinder).save({
        type: '45 KG',
        price: 1,
        weight: 45,
        stock: 0,
        isActive: true,
        distributorId: e.distributorId,
      } as Partial<GasCylinder>);

      const v = await vista(
        e,
        'garrafas',
        'Tipo;Peso (kg);Precio;Stock inicial\n' +
          '10 kg;10;100;3\n' +
          '12 kg;12;-5;\n' +
          '10 KG;10;100;\n' +
          '45 kg;45;100;\n' +
          '20 kg;abc;100;\n' +
          '25 kg;25;100;1,5\n',
      );

      expect(v.estado).toBe('with_errors');
      expect(v.total).toBe(6);
      expect(v.validas).toBe(1);
      expect(v.errores).toEqual([
        { fila: 3, columna: 'Precio', mensaje: 'Precio debe ser mayor que 0' },
        {
          fila: 4,
          columna: 'Tipo',
          mensaje:
            'El tipo está repetido en el archivo (ya figura en la fila 2)',
        },
        {
          fila: 5,
          columna: 'Tipo',
          mensaje: 'Ya existe una garrafa con este tipo en tu distribuidora',
        },
        { fila: 6, columna: 'Peso (kg)', mensaje: '"abc" no es un número' },
        {
          fila: 7,
          columna: 'Stock inicial',
          mensaje: 'Stock inicial debe ser un número entero',
        },
      ]);
      const resp = await confirmar(e, v.importId).expect(400);
      expect(cuerpo<Mensaje>(resp).message).toContain('5 error(es)');
      expect(await garrafas(e.distributorId)).toHaveLength(1);
    });

    it('confirma, crea el catálogo con su stock inicial físico y es idempotente', async () => {
      const e = await seedDistribuidora();
      const v = await vista(e, 'garrafas', CSV_OK);

      const primera = cuerpo<Confirmada>(
        await confirmar(e, v.importId).expect(201),
      );
      expect(primera).toMatchObject({
        estado: 'confirmed',
        resumen: { creadas: 3 },
        yaConfirmada: false,
      });
      const creadas = await garrafas(e.distributorId);
      expect(creadas.map((g) => [g.type, g.stock, g.price])).toEqual([
        ['10 kg', 5, 12500.5],
        ['15 kg', 0, 18000],
        ['45 kg', 2, 40000],
      ]);
      // El stock inicial es físico del depósito predeterminado, no sólo un número.
      expect(await saldo(e.locationId, creadas[0].gasCylinderId, 'full')).toBe(
        5,
      );

      const segunda = cuerpo<Confirmada>(
        await confirmar(e, v.importId).expect(201),
      );
      expect(segunda).toMatchObject({
        resumen: { creadas: 3 },
        yaConfirmada: true,
      });
      expect(await garrafas(e.distributorId)).toHaveLength(3);
      expect(await saldo(e.locationId, creadas[0].gasCylinderId, 'full')).toBe(
        5,
      );
    });

    it('dos confirmaciones simultáneas aplican una sola vez', async () => {
      const e = await seedDistribuidora();
      const v = await vista(e, 'garrafas', CSV_OK);

      const respuestas = await Promise.all([
        confirmar(e, v.importId),
        confirmar(e, v.importId),
        confirmar(e, v.importId),
      ]);

      expect(respuestas.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(
        respuestas.filter((r) => !cuerpo<Confirmada>(r).yaConfirmada),
      ).toHaveLength(1);
      expect(await garrafas(e.distributorId)).toHaveLength(3);
    });

    it('todo o nada: si una fila falla al confirmar, no queda ninguna de las anteriores', async () => {
      const e = await seedDistribuidora();
      const v = await vista(e, 'garrafas', CSV_OK);
      // Entre la vista previa y la confirmación alguien da de alta el último tipo.
      await ds.getRepository(GasCylinder).save({
        type: '45 kg',
        price: 1,
        weight: 45,
        stock: 0,
        isActive: true,
        distributorId: e.distributorId,
      } as Partial<GasCylinder>);

      const resp = await confirmar(e, v.importId).expect(400);

      expect(cuerpo<Mensaje>(resp).message).toBe(
        'Fila 4: Ya existe una garrafa con este tipo en tu distribuidora',
      );
      const quedan = await garrafas(e.distributorId);
      expect(quedan.map((g) => g.type)).toEqual(['45 kg']);
      expect(await saldo(e.locationId, quedan[0].gasCylinderId, 'full')).toBe(
        0,
      );
      const job = await ds
        .getRepository(ImportJob)
        .findOneByOrFail({ importId: v.importId });
      expect(job.status).toBe('pending');
      expect(job.confirmedAt).toBeNull();
    });

    it('una vista previa vencida es 410', async () => {
      const e = await seedDistribuidora();
      const v = await vista(e, 'garrafas', CSV_OK);
      await ds.query(
        `UPDATE import_job SET expires_at = now() - interval '1 minute' WHERE import_id = $1`,
        [v.importId],
      );
      await confirmar(e, v.importId).expect(410);
      expect(await garrafas(e.distributorId)).toEqual([]);
    });
  });

  describe('aislamiento entre distribuidoras', () => {
    it('no se confirma ni se ve la importación de otra, y los tipos no chocan entre tenants', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      const csv = 'Tipo;Peso (kg);Precio\n10 kg;10;100\n';
      const delA = await vista(a, 'garrafas', csv);

      await confirmar(b, delA.importId).expect(404);
      expect(await garrafas(a.distributorId)).toEqual([]);
      expect(await garrafas(b.distributorId)).toEqual([]);

      await confirmar(a, delA.importId).expect(201);
      // B puede cargar el mismo tipo: la unicidad es por distribuidora.
      const delB = await vista(b, 'garrafas', csv);
      expect(delB.estado).toBe('pending');
      await confirmar(b, delB.importId).expect(201);
      expect(
        (await garrafas(a.distributorId)).map((g) => g.distributorId),
      ).toEqual([a.distributorId]);
      expect(
        (await garrafas(b.distributorId)).map((g) => g.distributorId),
      ).toEqual([b.distributorId]);
    });

    it('los precios de una distribuidora no alcanzan los tipos de otra', async () => {
      const a = await seedDistribuidora();
      const b = await seedDistribuidora();
      await ds.getRepository(GasCylinder).save({
        type: '10 kg',
        price: 100,
        weight: 10,
        stock: 0,
        isActive: true,
        distributorId: a.distributorId,
      } as Partial<GasCylinder>);

      const v = await vista(b, 'precios', 'Tipo;Precio nuevo\n10 kg;999\n');

      expect(v.errores).toEqual([
        {
          fila: 2,
          columna: 'Tipo',
          mensaje: 'No existe una garrafa con ese tipo en tu distribuidora',
        },
      ]);
    });
  });

  describe('precios', () => {
    it('actualiza en bloque y deja el historial en la auditoría', async () => {
      const e = await seedDistribuidora();
      const g1 = await ds.getRepository(GasCylinder).save({
        type: '10 kg',
        price: 100,
        weight: 10,
        stock: 7,
        isActive: true,
        distributorId: e.distributorId,
      } as Partial<GasCylinder>);
      const g2 = await ds.getRepository(GasCylinder).save({
        type: '15 kg',
        price: 200,
        weight: 15,
        stock: 0,
        isActive: true,
        distributorId: e.distributorId,
      } as Partial<GasCylinder>);

      const v = await vista(
        e,
        'precios',
        'Tipo;Precio nuevo\n10 kg;150,50\n15 kg;200\n',
      );
      expect(v.vistaPrevia[0].datos).toMatchObject({
        price: 150.5,
        previousPrice: 100,
      });
      const r = cuerpo<Confirmada>(await confirmar(e, v.importId).expect(201));

      expect(r.resumen).toEqual({ actualizadas: 1, sinCambio: 1 });
      const [a, b] = await Promise.all([
        ds
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: g1.gasCylinderId }),
        ds
          .getRepository(GasCylinder)
          .findOneByOrFail({ gasCylinderId: g2.gasCylinderId }),
      ]);
      expect([a.price, a.stock, b.price]).toEqual([150.5, 7, 200]);
      const asientos = await ds.query<Array<{ n: string }>>(
        `SELECT count(*)::text AS n FROM audit_detail WHERE new_value LIKE '%150.5%' OR old_value LIKE '%100%'`,
      );
      expect(Number(asientos[0].n)).toBeGreaterThan(0);
    });
  });

  describe('stock', () => {
    it('aplica el conteo por depósito con su ajuste numerado y deja el vendible alineado', async () => {
      const e = await seedDistribuidora();
      const g = await ds.getRepository(GasCylinder).save({
        type: '10 kg',
        price: 100,
        weight: 10,
        stock: 0,
        isActive: true,
        distributorId: e.distributorId,
      } as Partial<GasCylinder>);

      const v = await vista(
        e,
        'stock',
        `Depósito;Tipo;Condición;Variación\n${e.codigoDeposito};10 kg;llena;40\n${e.codigoDeposito};10 kg;vacías;12\n`,
      );
      expect(v.errores).toEqual([]);
      const r = cuerpo<Confirmada>(await confirmar(e, v.importId).expect(201));

      expect(r.resumen).toEqual({
        filasAplicadas: 2,
        ajustes: 1,
        depositos: 1,
      });
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(40);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(12);
      expect(
        (
          await ds
            .getRepository(GasCylinder)
            .findOneByOrFail({ gasCylinderId: g.gasCylinderId })
        ).stock,
      ).toBe(40);
      const ajustes = await ds.query<
        Array<{ number: number; reason: string; notes: string }>
      >(`SELECT number, reason, notes FROM stock_adjustment`);
      expect(ajustes).toEqual([
        {
          number: 1,
          reason: 'count_correction',
          notes: 'Importación masiva de stock (carga.csv)',
        },
      ]);
    });

    it('todo o nada: un descuento que deja el saldo negativo revierte los ajustes anteriores', async () => {
      const e = await seedDistribuidora();
      const g = await ds.getRepository(GasCylinder).save({
        type: '10 kg',
        price: 100,
        weight: 10,
        stock: 0,
        isActive: true,
        distributorId: e.distributorId,
      } as Partial<GasCylinder>);
      // Al subir el archivo hay 3 vacías: la vista previa es válida. Antes de
      // confirmar se pierde una, y el descuento de 3 ya no entra.
      await http()
        .post('/stock/initial-counts')
        .set(e.headers)
        .set('Idempotency-Key', randomUUID())
        .send({
          warehouseId: e.warehouseId,
          items: [{ gasCylinderId: g.gasCylinderId, full: 0, empty: 3 }],
        })
        .expect(201);
      const v = await vista(
        e,
        'stock',
        `Depósito;Tipo;Condición;Variación\n${e.codigoDeposito};10 kg;llena;40\n${e.codigoDeposito};10 kg;vacía;-3\n`,
      );
      await http()
        .post('/stock/adjustments')
        .set(e.headers)
        .set('Idempotency-Key', randomUUID())
        .send({
          location: { warehouseId: e.warehouseId },
          reason: 'lost',
          notes: 'Una vacía que no apareció',
          items: [
            {
              gasCylinderId: g.gasCylinderId,
              condition: 'empty',
              quantityDelta: -1,
            },
          ],
        })
        .expect(201);
      const contarAjustes = async () =>
        (
          await ds.query<Array<{ n: string }>>(
            `SELECT count(*)::text AS n FROM stock_adjustment`,
          )
        )[0].n;
      const ajustesAntes = await contarAjustes();

      const resp = await confirmar(e, v.importId).expect(400);

      expect(cuerpo<Mensaje>(resp).message).toMatch(
        new RegExp(`^Depósito ${e.codigoDeposito}: Stock insuficiente`),
      );
      expect(await saldo(e.locationId, g.gasCylinderId, 'full')).toBe(0);
      expect(await saldo(e.locationId, g.gasCylinderId, 'empty')).toBe(2);
      expect(await contarAjustes()).toBe(ajustesAntes);
    });
  });

  describe('proveedores', () => {
    it('valida CUIT y repetidos, y confirma con el alta unitaria', async () => {
      const e = await seedDistribuidora();
      const encabezado = 'Razón social;CUIT;Tipo;Plazo de pago (días)\n';
      const malo = await vista(
        e,
        'proveedores',
        `${encabezado}Gas del Litoral;30-71234567-1;planta fraccionadora;30\nOtro;30-71234567-1;otro;\nTercero;30-71234567-2;otro;\n`,
      );
      expect(malo.errores.map((x) => [x.fila, x.columna])).toEqual([
        [3, 'CUIT'],
        [4, 'CUIT'],
      ]);

      const bueno = await vista(
        e,
        'proveedores',
        `${encabezado}Gas del Litoral;30-71234567-1;planta fraccionadora;30\nCorralón;20-12345678-6;otro;\n`,
      );
      const r = cuerpo<Confirmada>(
        await confirmar(e, bueno.importId).expect(201),
      );
      expect(r.resumen).toEqual({ creados: 2 });
      const filas = await ds.query<
        Array<{ cuit: string; kind: string; payment_terms_days: number | null }>
      >(
        `SELECT cuit, kind, payment_terms_days FROM supplier WHERE distributor_id = $1 ORDER BY cuit`,
        [e.distributorId],
      );
      expect(filas).toEqual([
        { cuit: '20123456786', kind: 'other', payment_terms_days: null },
        { cuit: '30712345671', kind: 'filling_plant', payment_terms_days: 30 },
      ]);
    });
  });

  describe('archivo', () => {
    it('lee un .xlsx real', async () => {
      const e = await seedDistribuidora();
      const libro = new Workbook();
      const hoja = libro.addWorksheet('Hoja');
      hoja.addRow(['Tipo', 'Peso (kg)', 'Precio']);
      hoja.addRow(['10 kg', 10, 12500.5]);
      const buffer = Buffer.from(await libro.xlsx.writeBuffer());

      const res = await http()
        .post('/v2/imports/garrafas/preview')
        .set(e.headers)
        .attach('file', buffer, 'carga.xlsx')
        .expect(201);

      expect(cuerpo<Vista>(res)).toMatchObject({
        estado: 'pending',
        validas: 1,
      });
    });

    it('rechaza lo que no es xlsx ni csv, el encabezado equivocado y el recurso inexistente', async () => {
      const e = await seedDistribuidora();
      await http()
        .post('/v2/imports/garrafas/preview')
        .set(e.headers)
        .attach('file', Buffer.from('%PDF-1.4'), 'a.pdf')
        .expect(415);
      await subir(e, 'garrafas', 'Color\nrojo\n').expect(400);
      await http()
        .post('/v2/imports/garrafas/preview')
        .set(e.headers)
        .expect(400);
      await subir(e, 'clientes', 'Tipo\n1\n').expect(400);
    });
  });
});
