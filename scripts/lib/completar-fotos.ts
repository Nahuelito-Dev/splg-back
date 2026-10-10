/**
 * Lógica de `scripts/completar-fotos-demo.ts`: deja con foto en S3 a los
 * registros de demo que hoy tienen una URL externa, una key rota (el objeto no
 * existe en el bucket) o ninguna foto. No borra ni regenera datos.
 *
 * Escribe como la app: reserva la key (`storage_orphan`), sube el objeto y
 * confirma la reserva en la misma transacción que guarda la referencia.
 */
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { FiguraDemo, generarImagenDemo } from './imagenes-demo';

/** Lo que el script necesita del almacenamiento (lo cumplen S3Service y un doble en tests). */
export interface AlmacenDeFotos {
  put(entrada: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<void>;
  /** HeadObject: ¿el objeto existe en el bucket? */
  existe(key: string): Promise<boolean>;
}

/** Lo que el script necesita de `S3CleanupService`. */
export interface ReservasDeSubida {
  reserveUpload(key: string): Promise<void>;
  confirmUpload(manager: EntityManager, key: string): Promise<void>;
}

export interface TablaDeFotos {
  /** Nombre en el resumen. */
  nombre: string;
  tabla: string;
  columnaId: string;
  columnaKey: string;
  /** Columna con la URL externa heredada, si la tabla tiene una. */
  columnaUrl?: string;
  /** Columna que filtra por distribuidora. */
  columnaDistribuidora: string;
  /** Condición extra (filas dadas de baja). */
  filtro?: string;
  figura: FiguraDemo;
  /** Prefijo de la key, sin barra final (misma convención que la app). */
  carpeta: (distribuidoraId: string, id: string) => string;
}

export const TABLAS_DE_FOTOS: readonly TablaDeFotos[] = [
  {
    nombre: 'claims (reclamos)',
    tabla: 'claims',
    columnaId: 'claim_id',
    columnaKey: 'photo_key',
    columnaUrl: 'photoUrl',
    columnaDistribuidora: 'distributor_id',
    figura: 'garrafa',
    carpeta: (d, id) => `claims/${d}/${id}`,
  },
  {
    nombre: 'incident (incidencias)',
    tabla: 'incident',
    columnaId: 'incident_id',
    columnaKey: 'photo_key',
    columnaUrl: 'photo_url',
    columnaDistribuidora: 'distributor_id',
    figura: 'aviso',
    carpeta: (d, id) => `incidents/${d}/${id}`,
  },
  {
    nombre: 'gas_cylinder (productos)',
    tabla: 'gas_cylinder',
    columnaId: 'gas_cylinder_id',
    columnaKey: 'photo_key',
    columnaDistribuidora: 'distributor_id',
    figura: 'garrafa',
    carpeta: (d, id) => `gascylinders/${d}/${id}`,
  },
  {
    nombre: 'car (vehículos)',
    tabla: 'car',
    columnaId: 'car_id',
    columnaKey: 'photo_key',
    columnaDistribuidora: 'distributor_id',
    filtro: '"deletedAt" IS NULL',
    figura: 'camioneta',
    carpeta: (d, id) => `cars/${d}/${id}`,
  },
  {
    nombre: 'distributor (logo)',
    tabla: 'distributor',
    columnaId: 'distributor_id',
    columnaKey: 'logo_key',
    columnaUrl: 'logo_url',
    columnaDistribuidora: 'distributor_id',
    filtro: '"deletedAt" IS NULL',
    figura: 'logo',
    carpeta: (d) => `distributors/${d}/logo`,
  },
];

export type Motivo = 'sin foto' | 'URL externa' | 'key rota';

export interface ResumenDeTabla {
  nombre: string;
  /** Subidas (o, en dry-run, las que se subirían). */
  subidas: number;
  yaEstabanBien: number;
  /** URL http del propio bucket sin key: no se toca. */
  omitidas: number;
  fallidas: number;
  detalle: Array<{ id: string; motivo: Motivo }>;
}

export interface OpcionesDeCompletado {
  ds: DataSource;
  almacen: AlmacenDeFotos;
  reservas: ReservasDeSubida;
  distribuidoraId: string;
  bucket: string;
  /** Endpoint S3 compatible (MinIO), para reconocer sus URLs como propias. */
  endpoint?: string;
  dryRun?: boolean;
  /** Para informar cada error de subida; por defecto no hace nada. */
  alFallar?: (tabla: string, id: string, error: unknown) => void;
}

const esHttp = (valor: string): boolean => /^https?:\/\//i.test(valor.trim());

/** ¿La URL apunta a nuestro bucket (virtual-hosted o path-style)? */
export function esUrlDelBucket(
  url: string,
  bucket: string,
  endpoint?: string,
): boolean {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith(`${bucket}.`)) return true;
    if (endpoint) {
      const e = new URL(endpoint);
      return u.host === e.host && u.pathname.startsWith(`/${bucket}/`);
    }
    return false;
  } catch {
    return false;
  }
}

interface Fila {
  id: string;
  key: string | null;
  url: string | null;
}

async function filasDe(
  ds: DataSource,
  t: TablaDeFotos,
  distribuidoraId: string,
): Promise<Fila[]> {
  const url = t.columnaUrl ? `"${t.columnaUrl}"` : 'NULL';
  const filas: unknown = await ds.query(
    `SELECT "${t.columnaId}" AS id, "${t.columnaKey}" AS key, ${url} AS url
       FROM "${t.tabla}"
      WHERE "${t.columnaDistribuidora}" = $1 ${t.filtro ? `AND ${t.filtro}` : ''}
      ORDER BY "${t.columnaId}"`,
    [distribuidoraId],
  );
  return filas as Fila[];
}

export async function completarFotos(
  opciones: OpcionesDeCompletado,
  tablas: readonly TablaDeFotos[] = TABLAS_DE_FOTOS,
): Promise<ResumenDeTabla[]> {
  const { ds, almacen, reservas, distribuidoraId, bucket, endpoint } = opciones;
  const resumenes: ResumenDeTabla[] = [];

  for (const t of tablas) {
    const resumen: ResumenDeTabla = {
      nombre: t.nombre,
      subidas: 0,
      yaEstabanBien: 0,
      omitidas: 0,
      fallidas: 0,
      detalle: [],
    };
    resumenes.push(resumen);

    let variante = 0;
    for (const fila of await filasDe(ds, t, distribuidoraId)) {
      let motivo: Motivo;
      if (fila.key) {
        if (await almacen.existe(fila.key)) {
          resumen.yaEstabanBien += 1;
          continue;
        }
        motivo = 'key rota';
      } else if (fila.url && esHttp(fila.url)) {
        if (esUrlDelBucket(fila.url, bucket, endpoint)) {
          resumen.omitidas += 1;
          continue;
        }
        motivo = 'URL externa';
      } else {
        motivo = 'sin foto';
      }

      resumen.detalle.push({ id: fila.id, motivo });
      if (opciones.dryRun) {
        resumen.subidas += 1;
        continue;
      }

      const key = `${t.carpeta(distribuidoraId, fila.id)}/${randomUUID()}.png`;
      try {
        await reservas.reserveUpload(key);
        await almacen.put({
          key,
          body: generarImagenDemo({ figura: t.figura, variante }),
          contentType: 'image/png',
        });
        await ds.transaction(async (manager) => {
          const limpiarUrl =
            t.columnaUrl && fila.url && esHttp(fila.url)
              ? `, "${t.columnaUrl}" = NULL`
              : '';
          await manager.query(
            `UPDATE "${t.tabla}" SET "${t.columnaKey}" = $1${limpiarUrl} WHERE "${t.columnaId}" = $2`,
            [key, fila.id],
          );
          await reservas.confirmUpload(manager, key);
        });
        resumen.subidas += 1;
        variante += 1;
      } catch (error) {
        resumen.fallidas += 1;
        opciones.alFallar?.(t.nombre, fila.id, error);
      }
    }
  }
  return resumenes;
}

export function formatearResumen(
  resumenes: readonly ResumenDeTabla[],
  dryRun: boolean,
): string {
  const cabecera = dryRun ? 'a subir' : 'subidas';
  const lineas = [
    `${'tabla'.padEnd(28)} ${cabecera.padStart(8)} ${'ya bien'.padStart(8)} ${'omitidas'.padStart(9)} ${'fallidas'.padStart(9)}`,
  ];
  for (const r of resumenes) {
    lineas.push(
      `${r.nombre.padEnd(28)} ${String(r.subidas).padStart(8)} ${String(r.yaEstabanBien).padStart(8)} ${String(r.omitidas).padStart(9)} ${String(r.fallidas).padStart(9)}`,
    );
  }
  return lineas.join('\n');
}
