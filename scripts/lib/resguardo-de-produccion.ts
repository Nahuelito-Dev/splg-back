/**
 * El seed borra y regenera datos: no corre contra algo que parezca producción
 * salvo que se lo pidan explícitamente con `SEED_ALLOW_PRODUCTION=true`.
 */
export function resguardoDeProduccion(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.SEED_ALLOW_PRODUCTION === 'true') return;
  const sospechas: string[] = [];
  if (env.NODE_ENV === 'production') sospechas.push('NODE_ENV=production');
  for (const variable of ['DB_NAME', 'DB_HOST', 'AWS_S3_BUCKET']) {
    const valor = env[variable];
    if (valor && /prod/i.test(valor)) sospechas.push(`${variable}=${valor}`);
  }
  if (sospechas.length) {
    throw new Error(
      `Esto parece producción (${sospechas.join(', ')}): el seed borra y regenera datos. ` +
        'Si es a propósito, repetí con SEED_ALLOW_PRODUCTION=true',
    );
  }
}

/**
 * Borrar objetos del bucket es irreversible y el `.env` real apunta al bucket
 * real: el seed sólo purga S3 con `SEED_PURGE_S3=1` explícito.
 */
export function purgaS3Habilitada(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SEED_PURGE_S3 === '1';
}
