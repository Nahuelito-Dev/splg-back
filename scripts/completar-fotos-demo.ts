/**
 * Completa las fotos de la demo SOBRE LOS DATOS EXISTENTES.
 *
 *   npm run fotos:demo             sube y guarda las fotos que faltan
 *   npm run fotos:demo -- --dry-run   lista qué haría, sin escribir
 *
 * Deja con foto en S3 a los reclamos, incidencias, productos, vehículos, al
 * logo de la distribuidora, a sus usuarios (admins, choferes y clientes) y a
 * los legajos sin cuenta que hoy tienen una URL externa, una key rota (el
 * objeto no existe en el bucket) o ninguna foto. Las personas reciben un
 * avatar generado en código (silueta de un color por persona). Es idempotente:
 * una segunda corrida no sube nada, y las fotos que ya existen no se tocan.
 *
 * Exige `SEED_S3=1`: sin esa bandera avisa y no toca S3.
 *
 * Variables: las de la base (`DB_*`), las del bucket (`AWS_*`) y
 * `SEED_DISTRIBUTOR` (slug, por defecto `demo`). Se niega a correr contra
 * algo que parezca producción salvo `SEED_ALLOW_PRODUCTION=true`.
 */
import 'dotenv/config';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { S3Service } from '../src/s3/s3.service';
import { readS3Settings } from '../src/s3/s3.config';
import { S3CleanupService } from '../src/s3/s3-cleanup.service';
import { StorageOrphan } from '../src/s3/entities/storage-orphan.entity';
import {
  AlmacenDeFotos,
  completarFotos,
  formatearResumen,
} from './lib/completar-fotos';
import { resguardoDeProduccion } from './lib/resguardo-de-produccion';
import { s3DelSeedHabilitado } from './lib/storage-demo';

const SLUG = process.env.SEED_DISTRIBUTOR ?? 'demo';
const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  resguardoDeProduccion();
  if (!s3DelSeedHabilitado()) {
    console.warn(
      '\nSin SEED_S3=1 este script no toca S3 (ni siquiera para mirar): no se hizo nada.\n' +
        'Repetí con SEED_S3=1 (y confirmá que el .env apunta al bucket que querés).\n',
    );
    return;
  }

  const config = new ConfigService();
  if (!config.get('AWS_S3_BUCKET') || !config.get('AWS_REGION')) {
    throw new Error('Faltan AWS_S3_BUCKET y AWS_REGION: no hay a dónde subir');
  }
  const ajustes = readS3Settings(config);
  const s3 = new S3Service(config);
  const cliente = new S3Client(ajustes.client);
  const almacen: AlmacenDeFotos = {
    put: (entrada) => s3.put(entrada),
    async existe(key) {
      try {
        await cliente.send(
          new HeadObjectCommand({ Bucket: ajustes.bucket, Key: key }),
        );
        return true;
      } catch (error) {
        const e = error as {
          name?: string;
          $metadata?: { httpStatusCode?: number };
        };
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
          return false;
        }
        throw error;
      }
    },
  };

  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    entities: [StorageOrphan],
    synchronize: false,
  });
  await ds.initialize();
  try {
    const filas: unknown = await ds.query(
      `SELECT distributor_id, name FROM distributor WHERE slug = $1 AND "deletedAt" IS NULL`,
      [SLUG],
    );
    const [dist] = filas as Array<{ distributor_id: string; name: string }>;
    if (!dist) throw new Error(`No existe la distribuidora '${SLUG}'`);
    console.log(
      `\nDistribuidora: ${dist.name} (${SLUG})${DRY_RUN ? '  [--dry-run: no se escribe nada]' : ''}`,
    );

    const resumenes = await completarFotos({
      ds,
      almacen,
      reservas: new S3CleanupService(s3, ds.getRepository(StorageOrphan)),
      distribuidoraId: dist.distributor_id,
      bucket: ajustes.bucket,
      endpoint: ajustes.client.endpoint as string | undefined,
      dryRun: DRY_RUN,
      alFallar: (tabla, id, error) =>
        console.error(
          `  ! ${tabla} ${id}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });

    if (DRY_RUN) {
      for (const r of resumenes) {
        for (const d of r.detalle)
          console.log(`  ${r.nombre}  ${d.id}  (${d.motivo})`);
      }
    }
    console.log(`\n${formatearResumen(resumenes, DRY_RUN)}\n`);
    if (resumenes.some((r) => r.fallidas > 0)) process.exitCode = 1;
  } finally {
    await ds.destroy();
    cliente.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(
    '\nNo se pudieron completar las fotos:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
