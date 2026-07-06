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
import { AppModule } from '../src/app.module';
import { RoleService } from '../src/role/role.service';
import { UsersService } from '../src/users/users.service';
import { AdminService } from '../src/admin/admin.service';

const PASSWORD = 'Test1234'; // Firebase exige >= 6 caracteres.

interface TestUser {
  role: 'super_admin' | 'admin' | 'customer' | 'delivery';
  email: string;
  full_name: string;
  phone_number: string; // E.164 (Firebase lo valida)
}

const TEST_USERS: TestUser[] = [
  {
    role: 'super_admin',
    email: 'superadmin@jennygas.com',
    full_name: 'Super Admin',
    phone_number: '+5493815550001',
  },
  {
    role: 'admin',
    email: 'admin@jennygas.com',
    full_name: 'Admin Jeny',
    phone_number: '+5493815550002',
  },
  {
    role: 'customer',
    email: 'cliente@jennygas.com',
    full_name: 'Cliente Prueba',
    phone_number: '+5493815550003',
  },
  {
    role: 'delivery',
    email: 'chofer@jennygas.com',
    full_name: 'Chofer Prueba',
    phone_number: '+5493815550004',
  },
];

async function bootstrap() {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  const roleService = app.get(RoleService);
  const usersService = app.get(UsersService);
  const adminService = app.get(AdminService);

  const results: Array<{ email: string; role: string; status: string }> = [];

  try {
    // 1) Roles ────────────────────────────────────────────────────────────
    await roleService.seedRoles();
    logger.log('✅ Roles sembrados (customer, delivery, admin, super_admin)');

    const roleIdByType: Record<string, string> = {};
    for (const type of ['admin', 'super_admin']) {
      const role = await roleService.findByType(type);
      if (!role) throw new Error(`Rol '${type}' no encontrado tras el seed`);
      roleIdByType[type] = role.role_id;
    }

    // 2) Usuarios de prueba ────────────────────────────────────────────────
    for (const u of TEST_USERS) {
      const exists = await userExists(usersService, u.email);
      if (exists) {
        results.push({ email: u.email, role: u.role, status: 'ya existía ⏭️' });
        continue;
      }

      try {
        if (u.role === 'customer') {
          await usersService.createCustomerWithUser({
            email: u.email,
            password: PASSWORD,
            full_name: u.full_name,
            phone_number: u.phone_number,
          });
        } else if (u.role === 'delivery') {
          await usersService.createDeliveryWithUser({
            email: u.email,
            password: PASSWORD,
            full_name: u.full_name,
            phone_number: u.phone_number,
            validated: true,
            isActive: true,
          } as any);
        } else {
          // admin / super_admin
          await adminService.registerAdmin({
            email: u.email,
            password: PASSWORD,
            full_name: u.full_name,
            phone_number: u.phone_number,
            role_id: roleIdByType[u.role],
          });
        }
        results.push({ email: u.email, role: u.role, status: 'creado ✅' });
      } catch (error) {
        results.push({
          email: u.email,
          role: u.role,
          status: `error ❌ ${(error as Error).message}`,
        });
      }
    }
  } finally {
    printSummary(results);
    await app.close();
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
