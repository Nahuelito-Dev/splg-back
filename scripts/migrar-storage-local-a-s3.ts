/**
 * Pasa los archivos de `storage-local/` (driver local) al bucket de S3 con la
 * MISMA key y su content-type (el que guardó el driver local en el `.meta.json`
 * de cada archivo), así los registros de la base siguen apuntando a lo mismo.
 *
 *   npm run storage:migrar -- --dry-run     # lista lo que subiría, sin subir
 *   npm run storage:migrar                  # sube
 *   npm run storage:migrar -- --path=/ruta/a/storage-local
 *
 * Idempotente: lo que ya está en el bucket con el mismo tamaño se saltea, así
 * que se puede correr de nuevo después de un corte. No borra nada, ni del
 * disco ni del bucket. Lee STORAGE_S3_* y STORAGE_LOCAL_PATH del `.env`.
 */
import 'dotenv/config';
import { readdir, readFile, stat } from 'fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface MigracionOpciones {
  /** Carpeta del driver local. */
  origen: string;
  bucket: string;
  client: S3Client;
  dryRun: boolean;
  log?: (linea: string) => void;
}

export interface MigracionResultado {
  subidos: string[];
  yaEstaban: string[];
  errores: Array<{ key: string; motivo: string }>;
  /** Symlinks y archivos ocultos (`.DS_Store`...): no se siguen ni se suben. */
  omitidos: string[];
}

const CONTENT_TYPE_POR_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Lista los archivos regulares. Los symlinks no se siguen (podrían apuntar
 * fuera de la carpeta) y lo oculto (`.DS_Store`, `.git`...) se ignora: ambos
 * van a `omitidos`.
 */
async function archivosDe(
  carpeta: string,
  omitidos: string[],
): Promise<string[]> {
  const entradas = await readdir(carpeta, { withFileTypes: true });
  const archivos: string[] = [];
  for (const entrada of entradas) {
    const ruta = join(carpeta, entrada.name);
    if (entrada.isSymbolicLink() || entrada.name.startsWith('.')) {
      omitidos.push(ruta);
    } else if (entrada.isDirectory()) {
      archivos.push(...(await archivosDe(ruta, omitidos)));
    } else if (entrada.isFile() && !entrada.name.endsWith('.meta.json')) {
      archivos.push(ruta);
    }
  }
  return archivos;
}

async function contentTypeDe(ruta: string): Promise<string> {
  try {
    const meta = JSON.parse(await readFile(`${ruta}.meta.json`, 'utf-8')) as {
      contentType?: string;
    };
    if (meta.contentType) return meta.contentType;
  } catch {
    // Sin sidecar: se deduce de la extensión.
  }
  return (
    CONTENT_TYPE_POR_EXTENSION[extname(ruta).toLowerCase()] ??
    'application/octet-stream'
  );
}

async function tamanoEnBucket(
  { client, bucket }: Pick<MigracionOpciones, 'client' | 'bucket'>,
  key: string,
): Promise<number | null> {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return head.ContentLength ?? null;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NotFound' || name === 'NoSuchKey') return null;
    throw error;
  }
}

export async function migrar(
  opciones: MigracionOpciones,
): Promise<MigracionResultado> {
  const log = opciones.log ?? (() => undefined);
  const resultado: MigracionResultado = {
    subidos: [],
    yaEstaban: [],
    errores: [],
    omitidos: [],
  };

  for (const ruta of (
    await archivosDe(opciones.origen, resultado.omitidos)
  ).sort()) {
    // La key es la ruta relativa, con `/` aunque se corra en Windows.
    const key = relative(opciones.origen, ruta).split(sep).join('/');
    try {
      const { size } = await stat(ruta);
      if ((await tamanoEnBucket(opciones, key)) === size) {
        resultado.yaEstaban.push(key);
        log(`= ${key} (ya estaba)`);
        continue;
      }
      const contentType = await contentTypeDe(ruta);
      if (!opciones.dryRun) {
        await opciones.client.send(
          new PutObjectCommand({
            Bucket: opciones.bucket,
            Key: key,
            Body: await readFile(ruta),
            ContentType: contentType,
            ServerSideEncryption: 'AES256',
          }),
        );
      }
      resultado.subidos.push(key);
      log(`${opciones.dryRun ? '?' : '+'} ${key} (${contentType}, ${size} B)`);
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      resultado.errores.push({ key, motivo });
      log(`! ${key}: ${motivo}`);
    }
  }
  return resultado;
}

function requerida(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) throw new Error(`Falta ${nombre} en el entorno`);
  return valor;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pathArg = args.find((a) => a.startsWith('--path='))?.slice(7);
  const configurado =
    pathArg ?? process.env.STORAGE_LOCAL_PATH ?? './storage-local';
  const origen = isAbsolute(configurado)
    ? configurado
    : resolve(process.cwd(), configurado);

  const bucket = requerida('STORAGE_S3_BUCKET');
  const accessKeyId = process.env.STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_S3_SECRET_ACCESS_KEY;
  const client = new S3Client({
    region: requerida('STORAGE_S3_REGION'),
    endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true',
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });

  console.log(
    `${dryRun ? '[dry-run] ' : ''}${origen} -> s3://${bucket}${process.env.STORAGE_S3_ENDPOINT ? ` (${process.env.STORAGE_S3_ENDPOINT})` : ''}`,
  );
  const r = await migrar({ origen, bucket, client, dryRun, log: console.log });
  console.log(
    `\n${dryRun ? 'Subiría' : 'Subidos'}: ${r.subidos.length} · ya estaban: ${r.yaEstaban.length} · omitidos (symlinks/ocultos): ${r.omitidos.length} · errores: ${r.errores.length}`,
  );
  if (r.errores.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
