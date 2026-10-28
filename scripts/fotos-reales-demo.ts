/**
 * Cambia las figuras generadas de la demo por fotos reales (F8).
 *
 *   SEED_S3=1 npm run fotos:reales             sube y cambia
 *   SEED_S3=1 npm run fotos:reales -- --dry-run   lista qué haría, sin escribir
 *
 * - Reclamos e incidencias con la figura generada (`.png` de `fotos:demo`): si
 *   el motivo se puede fotografiar (envase abollado, pérdida, faltante, envase
 *   dañado, calle cortada) recibe una foto real; si no (precio, horario,
 *   atención, cliente ausente), se le saca la figura y queda sin foto.
 * - Proveedores, envases y cargas de camión sin foto reciben una.
 *
 * Las fotos están en `scripts/fotos-demo/` (autor y licencia en `CREDITOS.md`).
 * Pasa por `EntityPhotoService`, el mismo camino que el panel: valida la imagen,
 * le saca los metadatos, manda la anterior a limpiar y el cambio queda en la
 * auditoría de datos (actor: sistema). Es idempotente.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import {
  DestinoDeFoto,
  EntityPhotoService,
} from '../src/s3/entity-photo.service';
import { auditContext } from '../src/audit/data/audit-context';
import { Claim } from '../src/claims/entities/claim.entity';
import { Incident } from '../src/incident/entities/incident.entity';
import { Supplier } from '../src/purchase/entities/supplier.entity';
import { Cylinder } from '../src/cylinder/entities/cylinder.entity';
import { TruckLoad } from '../src/truck-load/entities/truck-load.entity';
import { resguardoDeProduccion } from './lib/resguardo-de-produccion';
import { s3DelSeedHabilitado } from './lib/storage-demo';

const SLUG = process.env.SEED_DISTRIBUTOR ?? 'demo';
const DRY_RUN = process.argv.includes('--dry-run');
const CARPETA = join(__dirname, 'fotos-demo');

/** Foto para el motivo de un reclamo; `null`: el motivo no se fotografía. */
function fotoDeReclamo(motivo: string): string | null {
  const m = motivo.toLowerCase();
  if (m.includes('pérdida')) return 'cilindros-valvulas.jpg';
  if (m.includes('abollado')) return 'cilindros-45kg.jpg';
  if (m.includes('faltó')) return 'garrafas-composite.jpg';
  return null;
}

/** Foto para una incidencia según su tipo y descripción. */
function fotoDeIncidencia(tipo: string, descripcion: string): string | null {
  if (tipo === 'damaged') return 'cilindros-valvulas.jpg';
  if (descripcion.toLowerCase().includes('calle cortada')) {
    return 'calle-cortada.jpg';
  }
  return null;
}

const ENVASES = ['cilindros-45kg.jpg', 'cilindros-valvulas.jpg'];
const PROVEEDORES = ['planta-glp.jpg', 'jaula-de-garrafas.jpg'];

interface Cambio {
  destino: DestinoDeFoto;
  id: string;
  carpeta: string;
  /** `null`: sacar la figura y dejarlo sin foto. */
  foto: string | null;
}

function archivo(nombre: string): Express.Multer.File {
  const buffer = readFileSync(join(CARPETA, nombre));
  return {
    buffer,
    size: buffer.length,
    mimetype: 'image/jpeg',
    originalname: nombre,
  } as Express.Multer.File;
}

async function main(): Promise<void> {
  resguardoDeProduccion();
  if (!s3DelSeedHabilitado()) {
    console.warn('\nSin SEED_S3=1 este script no toca S3: no se hizo nada.\n');
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const db = app.get(DataSource);
    const fotos = app.get(EntityPhotoService);
    const [dist] = await db.query<{ distributor_id: string }[]>(
      `SELECT distributor_id FROM distributor WHERE slug = $1`,
      [SLUG],
    );
    if (!dist) throw new Error(`No existe la distribuidora «${SLUG}»`);
    const d = dist.distributor_id;
    const cambios: Cambio[] = [];

    const reclamos = await db.query<{ id: string; reason: string }[]>(
      `SELECT claim_id AS id, reason FROM claims
        WHERE distributor_id = $1 AND photo_key LIKE '%.png'`,
      [d],
    );
    for (const r of reclamos) {
      cambios.push({
        destino: { entity: Claim, idProp: 'claimId', keyProp: 'photoKey' },
        id: r.id,
        carpeta: `claims/${d}/${r.id}`,
        foto: fotoDeReclamo(r.reason),
      });
    }

    const incidencias = await db.query<
      { id: string; type: string; description: string }[]
    >(
      `SELECT incident_id AS id, type, description FROM incident
        WHERE distributor_id = $1 AND photo_key LIKE '%.png'`,
      [d],
    );
    for (const i of incidencias) {
      cambios.push({
        destino: {
          entity: Incident,
          idProp: 'incidentId',
          keyProp: 'photoKey',
        },
        id: i.id,
        carpeta: `incidents/${d}/${i.id}`,
        foto: fotoDeIncidencia(i.type, i.description),
      });
    }

    // Los dados de baja (baja lógica) no se muestran: no se les pone foto.
    const sinFoto = async (
      tabla: string,
      columnaId: string,
      vigentes = '',
    ): Promise<string[]> =>
      (
        await db.query<{ id: string }[]>(
          `SELECT ${columnaId} AS id FROM ${tabla}
            WHERE distributor_id = $1 AND photo_key IS NULL ${vigentes}
            ORDER BY ${columnaId}`,
          [d],
        )
      ).map((f) => f.id);

    (
      await sinFoto('supplier', 'supplier_id', 'AND "deletedAt" IS NULL')
    ).forEach((id, n) =>
      cambios.push({
        destino: {
          entity: Supplier,
          idProp: 'supplierId',
          keyProp: 'photoKey',
        },
        id,
        carpeta: `suppliers/${d}/${id}`,
        foto: PROVEEDORES[n % PROVEEDORES.length],
      }),
    );
    (await sinFoto('cylinder', 'cylinder_id')).forEach((id, n) =>
      cambios.push({
        destino: {
          entity: Cylinder,
          idProp: 'cylinderId',
          keyProp: 'photoKey',
        },
        id,
        carpeta: `cylinders/${d}/${id}`,
        foto: ENVASES[n % ENVASES.length],
      }),
    );
    (await sinFoto('truck_load', 'load_id')).forEach((id) =>
      cambios.push({
        destino: { entity: TruckLoad, idProp: 'loadId', keyProp: 'photoKey' },
        id,
        carpeta: `truck-loads/${d}/${id}`,
        foto: 'camion-con-garrafas.jpg',
      }),
    );

    const resumen = new Map<string, number>();
    for (const c of cambios) {
      const clave = `${c.carpeta.split('/')[0]}: ${c.foto ?? 'sin foto'}`;
      resumen.set(clave, (resumen.get(clave) ?? 0) + 1);
    }
    console.log(`\n${DRY_RUN ? 'Haría' : 'Cambia'} ${cambios.length} fotos:`);
    for (const [clave, n] of resumen) console.log(`  ${n} × ${clave}`);
    if (DRY_RUN) return;

    // Sin request no hay usuario: la auditoría lo registra como sistema.
    await auditContext.run(
      { userId: null, ip: null, distributorId: d },
      async () => {
        let hechos = 0;
        for (const c of cambios) {
          if (c.foto) {
            await fotos.guardar(c.destino, c.id, archivo(c.foto), c.carpeta);
          } else {
            await fotos.quitar(c.destino, c.id);
          }
          if (++hechos % 25 === 0)
            console.log(`  … ${hechos}/${cambios.length}`);
        }
      },
    );
    console.log('✅ Listo\n');
  } finally {
    await app.close();
  }
}

// Sin `exit` el proceso queda vivo: la app deja abiertos Redis y las tareas programadas.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
