/**
 * Diagnóstico del bucket de archivos (SÓLO LECTURA: no cambia nada).
 *
 *   npm run s3:diagnostico
 *
 * Comprueba que el bucket tenga Block Public Access activo, que no tenga una
 * política pública y que la ACL no abra permisos a grupos públicos. Usa las
 * variables `AWS_*` del `.env`. Si las credenciales no pueden leer alguna de
 * esas configuraciones (AccessDenied), lo dice e imprime los pasos para
 * verificarlo desde la consola de AWS.
 *
 * Salida: 0 todo bien · 1 hay algo abierto · 2 no se pudo verificar algo.
 */
import 'dotenv/config';
import {
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { readS3Settings } from '../src/s3/s3.config';
import {
  codigoDeSalida,
  evaluarBucket,
  pasosParaNahu,
  Respuesta,
} from './lib/diagnostico-bucket';

interface ErrorDeAws {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

async function consultar<T>(
  pedir: () => Promise<T>,
  /** Códigos de error que significan "no está configurado" y no son un fallo. */
  vacios: readonly string[],
  vacio: T,
): Promise<Respuesta<T>> {
  try {
    return { ok: true, valor: await pedir() };
  } catch (error) {
    const e = error as ErrorDeAws;
    if (e.name && vacios.includes(e.name)) return { ok: true, valor: vacio };
    const denegado =
      e.name === 'AccessDenied' || e.$metadata?.httpStatusCode === 403;
    return {
      ok: false,
      denegado,
      mensaje: `${e.name ?? 'Error'}: ${e.message ?? String(error)}`,
    };
  }
}

async function main(): Promise<void> {
  const config = new ConfigService();
  if (!config.get('AWS_S3_BUCKET') || !config.get('AWS_REGION')) {
    throw new Error('Faltan AWS_S3_BUCKET y AWS_REGION');
  }
  const ajustes = readS3Settings(config);
  const cliente = new S3Client(ajustes.client);
  const Bucket = ajustes.bucket;
  const region = String(config.get('AWS_REGION'));
  console.log(`\nBucket: ${Bucket} (${region})  [sólo lectura]\n`);

  try {
    const hallazgos = evaluarBucket({
      publicAccessBlock: await consultar(
        async () =>
          (await cliente.send(new GetPublicAccessBlockCommand({ Bucket })))
            .PublicAccessBlockConfiguration ?? null,
        ['NoSuchPublicAccessBlockConfiguration'],
        null,
      ),
      politicaPublica: await consultar(
        async () =>
          (await cliente.send(new GetBucketPolicyStatusCommand({ Bucket })))
            .PolicyStatus?.IsPublic ?? false,
        ['NoSuchBucketPolicy'],
        null,
      ),
      gruposDeLaAcl: await consultar(
        async () =>
          (
            await cliente.send(new GetBucketAclCommand({ Bucket }))
          ).Grants?.flatMap((g) => (g.Grantee?.URI ? [g.Grantee.URI] : [])) ??
          [],
        [],
        [],
      ),
    });

    const marca = { ok: 'OK ', mal: 'MAL', 'sin-permiso': '???', error: 'ERR' };
    for (const h of hallazgos) {
      console.log(`  [${marca[h.veredicto]}] ${h.control}: ${h.detalle}`);
    }
    const salida = codigoDeSalida(hallazgos);
    if (hallazgos.some((h) => h.veredicto === 'sin-permiso')) {
      console.log(`\n${pasosParaNahu(Bucket, region)}`);
    }
    console.log(
      salida === 0
        ? '\nEl bucket está cerrado al público.\n'
        : salida === 1
          ? '\nATENCIÓN: hay una configuración que abre el bucket.\n'
          : '\nNo se pudo verificar todo: ver los pasos de arriba.\n',
    );
    process.exitCode = salida;
  } finally {
    cliente.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(
    '\nNo se pudo hacer el diagnóstico:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
