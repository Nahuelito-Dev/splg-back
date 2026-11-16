/**
 * Distribuidora de prueba propia de la plataforma.
 *
 *   npm run seed:empresa-propia
 *
 * Crea (o completa) «Distribuidora de prueba OrixTech» (`prueba-orixtech`),
 * marcada como propia de la plataforma: el administrador general la opera
 * directo, con lectura y escritura, mandando `X-Distributor: prueba-orixtech`,
 * sin sesión de soporte. Copia de la demo el catálogo, las franjas, las zonas de
 * Posadas y dos vehículos; deja el galpón en Posadas con stock inicial, dos
 * choferes y cinco clientes con cuenta en Firebase (`@splg-test.com`, clave
 * `Test1234`).
 *
 * Presupone `npm run seed` y `npm run seed:demo` (de ahí se copia). Usa las
 * credenciales de Firebase del `.env` (crea cuentas reales en el proyecto). Es
 * idempotente: lo que ya existe se saltea y no borra nada.
 *
 *   SEED_ORIGEN=demo   slug de la distribuidora de la que se copia
 */
import './lib/marcar-script';
import { NestFactory } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { CustomersService } from '../src/customer/customer.service';
import { RegistroService } from '../src/registro/registro.service';
import { CLAVE_DE_PRUEBA, sembrarEmpresaPropia } from './lib/empresa-propia';
import { resguardoDeProduccion } from './lib/resguardo-de-produccion';

async function main(): Promise<void> {
  resguardoDeProduccion();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const r = await sembrarEmpresaPropia({
      ds: app.get(DataSource),
      eventos: app.get(EventEmitter2),
      registro: app.get(RegistroService),
      clientes: app.get(CustomersService),
      origen: process.env.SEED_ORIGEN ?? 'demo',
      log: (l) => console.log(l),
    });
    console.log('\n──────── EMPRESA PROPIA DE LA PLATAFORMA ────────');
    console.log(
      `  distribuidora   ${r.distributorId} (${r.creada ? 'creada' : 'ya existía'})`,
    );
    console.log(`  productos       +${r.productos}`);
    console.log(`  franjas         +${r.franjas}`);
    console.log(`  zonas           +${r.zonas}`);
    console.log(
      `  vehículos       +${r.vehiculos} (asignados: ${r.asignaciones})`,
    );
    console.log(`  direcciones     +${r.direcciones}`);
    console.log(`  clave de las cuentas: ${CLAVE_DE_PRUEBA}`);
    for (const c of [...r.choferes, ...r.clientes]) {
      console.log(`  ${c.email.padEnd(34)} ${c.estado}`);
    }
    console.log('─────────────────────────────────────────────────\n');
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('La siembra de la empresa propia falló:', err);
    process.exit(1);
  });
