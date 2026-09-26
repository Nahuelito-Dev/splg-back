/**
 * Crea el primer super administrador (CU-087). Lo corre el Administrador
 * General desde el servidor; no hay endpoint para esto.
 *
 *   npm run crear-superadmin -- --email ana@splg.com --nombre "Ana Pérez" \
 *     --telefono +5493764000000
 *
 * La contraseña no va como argumento (quedaría en el historial de la
 * terminal): se lee de SUPERADMIN_PASSWORD o se pide por teclado.
 * Si ya existe un super administrador, no hace nada.
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { AppModule } from '../app.module';
import { AdminService } from '../admin/admin.service';
import { RegistroService } from '../registro/registro.service';
import { RoleType } from '../common/constants/role-type.enum';
import { errorMessage } from '../common/errors/error-message';

const logger = new Logger('CrearSuperAdmin');

function argumento(nombre: string): string {
  const i = process.argv.indexOf(`--${nombre}`);
  const valor = i >= 0 ? process.argv[i + 1] : undefined;
  if (!valor || valor.startsWith('--')) {
    throw new Error(`Falta --${nombre}`);
  }
  return valor;
}

/** Pide la contraseña sin mostrarla en pantalla. */
function pedirContraseña(): Promise<string> {
  let silencio = false;
  const salida = new Writable({
    write(chunk: Buffer, _enc, listo) {
      if (!silencio) process.stdout.write(chunk);
      listo();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: salida,
    terminal: true,
  });
  return new Promise((resolve) => {
    rl.question('Contraseña: ', (valor) => {
      rl.close();
      process.stdout.write('\n');
      resolve(valor);
    });
    silencio = true;
  });
}

async function main(): Promise<void> {
  const email = argumento('email');
  const full_name = argumento('nombre');
  const phone_number = argumento('telefono');
  const password = process.env.SUPERADMIN_PASSWORD ?? (await pedirContraseña());

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    if (await app.get(AdminService).existeSuperAdmin()) {
      logger.warn('Ya existe un super administrador: no se crea otro.');
      process.exitCode = 1;
      return;
    }
    const user = await app.get(RegistroService).registrar(
      {
        email,
        password,
        full_name,
        phone_number,
        rol: RoleType.SUPER_ADMIN,
      },
      { tipo: 'sistema' },
    );
    logger.log(`Super administrador creado: ${user.email} (${user.user_id})`);
  } finally {
    await app.close();
  }
}

// Salida explícita, como el seed: Redis y los programadores de tareas dejan
// conexiones abiertas aunque el contexto ya esté cerrado.
main()
  .catch((error: unknown) => {
    logger.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(() => process.exit());
