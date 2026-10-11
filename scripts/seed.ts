/**
 * Seed idempotente de datos base + usuarios de prueba.
 *
 *   npm run seed
 *
 * Qué hace (todo idempotente: si algo ya existe, lo saltea):
 *   1. Siembra los 4 roles: customer, delivery, admin, super_admin.
 *   2. Crea 1 usuario de prueba por rol, en Firebase + DB local + perfil.
 *
 * Reemplaza el bootstrap manual (crear super_admin a mano, seedear roles por
 * endpoint, etc.). Un solo comando deja el sistema listo para probar con tokens
 * reales. Corre en el contexto de la app (mismos servicios que producción).
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { RoleService } from '../src/role/role.service';
import { UsersService } from '../src/users/users.service';
import { DistributorService } from '../src/distributor/distributor.service';
import { RegistroService } from '../src/registro/registro.service';
import type { RolRegistrable } from '../src/registro/politica-de-registro';
import { Distributor } from '../src/distributor/entities/distributor.entity';
import { resguardoDeProduccion } from './lib/resguardo-de-produccion';
import { sembrarFisico } from './lib/stock-demo';

const PASSWORD = 'Test1234'; // Firebase exige >= 6 caracteres.

/** Tablas scopeadas por tenant (para el backfill de datos pre-multitenant). */
const SCOPED_TABLES = [
  'gas_cylinder',
  '"order"',
  'car',
  'time_slot',
  'claims',
  'delivery',
];

interface TestUser {
  role: 'super_admin' | 'admin' | 'customer' | 'delivery';
  email: string;
  full_name: string;
  phone_number: string; // E.164 (Firebase lo valida)
}

const TEST_USERS: TestUser[] = [
  {
    role: 'super_admin',
    email: 'superadmin@splg.com',
    full_name: 'Super Admin',
    phone_number: '+5493815550001',
  },
  {
    role: 'admin',
    email: 'admin@splg.com',
    full_name: 'Admin Demo',
    phone_number: '+5493815550002',
  },
  {
    role: 'customer',
    email: 'cliente@splg.com',
    full_name: 'Cliente Prueba',
    phone_number: '+5493815550003',
  },
  {
    role: 'delivery',
    email: 'chofer@splg.com',
    full_name: 'Chofer Prueba',
    phone_number: '+5493815550004',
  },
];

/**
 * Staff de la 2da distribuidora demo (Gas Andino), para probar el aislamiento
 * multi-tenant: su admin/chofer NO deben ver los datos de Distribuidora Demo y viceversa.
 * El customer es global (una identidad puede pedir a cualquier distribuidora
 * vía header X-Distributor), por eso no se duplica.
 */
const DEMO_STAFF: TestUser[] = [
  {
    role: 'admin',
    email: 'admin@gasandino.com',
    full_name: 'Admin Andino',
    phone_number: '+5493815550012',
  },
  {
    role: 'delivery',
    email: 'chofer@gasandino.com',
    full_name: 'Chofer Andino',
    phone_number: '+5493815550014',
  },
];

async function bootstrap() {
  resguardoDeProduccion();
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  const roleService = app.get(RoleService);
  const usersService = app.get(UsersService);
  const distributorService = app.get(DistributorService);
  const registro = app.get(RegistroService);
  const dataSource = app.get(DataSource);

  const results: Array<{ email: string; role: string; status: string }> = [];

  try {
    // 1) Roles ────────────────────────────────────────────────────────────
    await roleService.seedRoles();
    logger.log('✅ Roles sembrados (customer, delivery, admin, super_admin)');

    // 2) Multi-tenant: distribuidora default ───────────────────────────────
    // Se crea ANTES que los usuarios: delivery.distributor_id es NOT NULL, asi
    // que el chofer necesita su tenant ya existente al momento del alta.
    const distribuidoraDemo = await ensureDistributor(distributorService, {
      name: 'Distribuidora Demo',
      slug: 'demo',
      legalName: 'Distribuidora Demo S.R.L.',
      taxId: '30-11111111-1',
      email: 'contacto@splg.com',
      phone: '+543764000001',
    });
    logger.log(
      `✅ Distribuidora default: ${distribuidoraDemo.name} (${distribuidoraDemo.slug})`,
    );

    // 3) Usuarios de prueba ────────────────────────────────────────────────
    for (const u of TEST_USERS) {
      results.push(
        await ensureUser(
          u,
          usersService,
          registro,
          distribuidoraDemo.distributorId,
        ),
      );
    }

    // 4) Backfill de datos pre-multi-tenant ────────────────────────────────
    // Backfill: todas las filas scopeadas sin tenant → distribuidora default.
    // Corre ANTES de crear la 2da distribuidora para no pisar su staff.
    for (const table of SCOPED_TABLES) {
      await dataSource.query(
        `UPDATE ${table} SET distributor_id = $1 WHERE distributor_id IS NULL`,
        [distribuidoraDemo.distributorId],
      );
    }
    // En admin, null es un valor válido: es el super admin, que no pertenece a
    // ninguna distribuidora. Sólo se completan los admins de empresa (H-76).
    await dataSource.query(
      `UPDATE admin SET distributor_id = $1
         WHERE distributor_id IS NULL
           AND user_id IN (SELECT u.user_id FROM "user" u
                             JOIN role r ON r.role_id = u.role_id
                            WHERE r.type = 'admin')`,
      [distribuidoraDemo.distributorId],
    );
    logger.log(
      '✅ Backfill: datos pre-existentes asignados a la distribuidora default',
    );

    // 4) 2da distribuidora demo (Gas Andino) con staff + catálogo propios ──
    const gasAndino = await ensureDistributor(distributorService, {
      name: 'Gas Andino',
      slug: 'gas-andino',
      legalName: 'Gas Andino S.A.',
      taxId: '30-22222222-2',
      email: 'contacto@gasandino.com',
      phone: '+543764000002',
    });
    logger.log(`✅ Distribuidora demo: ${gasAndino.name} (${gasAndino.slug})`);

    for (const u of DEMO_STAFF) {
      results.push(
        await ensureUser(u, usersService, registro, gasAndino.distributorId),
      );
      await assignStaffToDistributor(
        dataSource,
        u.email,
        u.role,
        gasAndino.distributorId,
      );
    }

    // Catálogo propio de la distribuidora demo (idempotente: sólo si no tiene).
    await ensureDemoCatalog(dataSource, gasAndino.distributorId);
    // Su stock vendible inicial es físico: por el ledger, en el depósito central.
    await sembrarFisico(dataSource, gasAndino.distributorId);
    logger.log(
      '✅ Staff + catálogo de Gas Andino listos (aislados de Distribuidora Demo)',
    );
  } finally {
    printSummary(results);
    await app.close();
  }
}

/**
 * Crea un usuario de prueba (customer/delivery/admin/super_admin) si no existe.
 * Idempotente. Devuelve el registro de resultado para el resumen.
 */
async function ensureUser(
  u: TestUser,
  usersService: UsersService,
  registro: RegistroService,
  distributorId: string,
): Promise<{ email: string; role: string; status: string }> {
  if (await userExists(usersService, u.email)) {
    return { email: u.email, role: u.role, status: 'ya existía ⏭️' };
  }
  try {
    const rol = u.role as RolRegistrable;
    await registro.registrar(
      {
        email: u.email,
        password: PASSWORD,
        full_name: u.full_name,
        phone_number: u.phone_number,
        rol,
        // La política la ignora para clientes y super admins.
        distributorId,
        validated: true,
        isActive: true,
      },
      { tipo: 'sistema' },
    );
    return { email: u.email, role: u.role, status: 'creado ✅' };
  } catch (error) {
    return {
      email: u.email,
      role: u.role,
      status: `error ❌ ${(error as Error).message}`,
    };
  }
}

/** Crea la distribuidora si su slug no existe; siempre devuelve la fila. */
async function ensureDistributor(
  distributorService: DistributorService,
  data: Partial<Distributor> & { name: string; slug: string },
): Promise<Distributor> {
  try {
    return await distributorService.findBySlug(data.slug);
  } catch {
    return distributorService.create(data as any);
  }
}

/**
 * Asigna el perfil de staff (admin o delivery) de `email` a una distribuidora.
 * Idempotente: sobrescribe el distributor_id del perfil.
 */
async function assignStaffToDistributor(
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
}

/** Siembra un catálogo mínimo para la distribuidora demo (si no tiene). */
async function ensureDemoCatalog(
  dataSource: DataSource,
  distributorId: string,
): Promise<void> {
  const creado: { gas_cylinder_id: string }[] = await dataSource.query(
    `INSERT INTO gas_cylinder (type, weight, price, stock, description, "isActive", distributor_id)
     SELECT 'Garrafa 10kg Andino', 10, 11000, 40, 'Garrafa 10kg de Gas Andino', true, $1
     WHERE NOT EXISTS (SELECT 1 FROM gas_cylinder WHERE distributor_id = $1)
     RETURNING gas_cylinder_id`,
    [distributorId],
  );
  if (creado[0]) {
    await dataSource.query(
      `INSERT INTO gas_cylinder_promotion (gas_cylinder_id, quantity, discount_percentage)
       VALUES ($1, 3, 10)`,
      [creado[0].gas_cylinder_id],
    );
  }
}

async function userExists(
  usersService: UsersService,
  email: string,
): Promise<boolean> {
  try {
    const user = await usersService.findOneByEmail(email);
    return !!user;
  } catch {
    return false; // findOneByEmail lanza si no existe → lo tratamos como "no existe"
  }
}

function printSummary(
  results: Array<{ email: string; role: string; status: string }>,
) {
  // eslint-disable-next-line no-console
  console.log('\n──────────── USUARIOS DE PRUEBA ────────────');
  // eslint-disable-next-line no-console
  console.log(`Password (todos): ${PASSWORD}\n`);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  [${r.role.padEnd(12)}] ${r.email.padEnd(28)} → ${r.status}`);
  }
  // eslint-disable-next-line no-console
  console.log('────────────────────────────────────────────\n');
}

bootstrap()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Seed falló:', err);
    process.exit(1);
  });
