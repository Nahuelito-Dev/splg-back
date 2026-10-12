/**
 * Lógica de `scripts/diagnostico-bucket.ts`: decide, a partir de lo que
 * contesta S3, si el bucket está cerrado al público. Sólo lectura.
 */

export type Veredicto = 'ok' | 'mal' | 'sin-permiso' | 'error';

export interface Hallazgo {
  control: string;
  veredicto: Veredicto;
  detalle: string;
}

/** Lo que devolvió (o por qué falló) cada consulta a S3. */
export type Respuesta<T> =
  | { ok: true; valor: T }
  | { ok: false; denegado: boolean; mensaje: string };

export interface PublicAccessBlock {
  BlockPublicAcls?: boolean;
  IgnorePublicAcls?: boolean;
  BlockPublicPolicy?: boolean;
  RestrictPublicBuckets?: boolean;
}

export interface EntradasDelDiagnostico {
  publicAccessBlock: Respuesta<PublicAccessBlock | null>;
  /** `GetBucketPolicyStatus`: ¿S3 considera pública la política? */
  politicaPublica: Respuesta<boolean | null>;
  /** `GetBucketAcl`: URIs de los grupos con permisos (AllUsers, AuthenticatedUsers). */
  gruposDeLaAcl: Respuesta<string[]>;
}

const CAMPOS_BLOQUEO: Array<keyof PublicAccessBlock> = [
  'BlockPublicAcls',
  'IgnorePublicAcls',
  'BlockPublicPolicy',
  'RestrictPublicBuckets',
];

function sinDatos(
  control: string,
  r: Extract<Respuesta<unknown>, { ok: false }>,
): Hallazgo {
  return {
    control,
    veredicto: r.denegado ? 'sin-permiso' : 'error',
    detalle: r.mensaje,
  };
}

export function evaluarBucket(e: EntradasDelDiagnostico): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];

  const control1 = 'Block Public Access (las 4 opciones)';
  if (!e.publicAccessBlock.ok) {
    hallazgos.push(sinDatos(control1, e.publicAccessBlock));
  } else if (e.publicAccessBlock.valor === null) {
    hallazgos.push({
      control: control1,
      veredicto: 'mal',
      detalle: 'El bucket no tiene configuración de Block Public Access.',
    });
  } else {
    const apagadas = CAMPOS_BLOQUEO.filter(
      (c) => e.publicAccessBlock.ok && e.publicAccessBlock.valor?.[c] !== true,
    );
    hallazgos.push(
      apagadas.length === 0
        ? {
            control: control1,
            veredicto: 'ok',
            detalle: 'Las cuatro opciones están activas.',
          }
        : {
            control: control1,
            veredicto: 'mal',
            detalle: `Apagadas: ${apagadas.join(', ')}.`,
          },
    );
  }

  const control2 = 'Política del bucket';
  if (!e.politicaPublica.ok) {
    hallazgos.push(sinDatos(control2, e.politicaPublica));
  } else {
    hallazgos.push(
      e.politicaPublica.valor === true
        ? {
            control: control2,
            veredicto: 'mal',
            detalle: 'S3 considera pública la política del bucket.',
          }
        : {
            control: control2,
            veredicto: 'ok',
            detalle:
              e.politicaPublica.valor === null
                ? 'No hay política.'
                : 'La política no es pública.',
          },
    );
  }

  const control3 = 'ACL del bucket';
  if (!e.gruposDeLaAcl.ok) {
    hallazgos.push(sinDatos(control3, e.gruposDeLaAcl));
  } else {
    const publicos = e.gruposDeLaAcl.valor.filter((uri) =>
      /global\/(AllUsers|AuthenticatedUsers)$/.test(uri),
    );
    hallazgos.push(
      publicos.length === 0
        ? {
            control: control3,
            veredicto: 'ok',
            detalle: 'Sin permisos para grupos públicos.',
          }
        : {
            control: control3,
            veredicto: 'mal',
            detalle: `Permisos para: ${publicos.join(', ')}.`,
          },
    );
  }

  return hallazgos;
}

/** 0 todo bien; 1 hay algo abierto; 2 no se pudo verificar algo. */
export function codigoDeSalida(hallazgos: readonly Hallazgo[]): number {
  if (hallazgos.some((h) => h.veredicto === 'mal')) return 1;
  if (hallazgos.some((h) => h.veredicto !== 'ok')) return 2;
  return 0;
}

/** Pasos para nahu cuando las credenciales de la app no pueden leer la configuración. */
export function pasosParaNahu(bucket: string, region: string): string {
  return [
    `Las credenciales de la app no tienen permiso para leer la configuración del bucket "${bucket}".`,
    'Verificarlo a mano en la consola de AWS (con un usuario que sí pueda):',
    `  1. S3 > Buckets > ${bucket} > pestaña "Permisos".`,
    '  2. "Bloquear todo el acceso público": tiene que decir "Activado" (las 4 casillas).',
    '  3. "Política del bucket": vacía, o sin "Principal": "*" salvo con Deny (p. ej. SoloHTTPS).',
    '  4. "Lista de control de acceso (ACL)": ningún permiso para "Todos" ni "Usuarios autenticados de AWS".',
    'O con el AWS CLI y un perfil administrador:',
    `  aws s3api get-public-access-block --bucket ${bucket} --region ${region}`,
    `  aws s3api get-bucket-policy-status --bucket ${bucket} --region ${region}`,
    `  aws s3api get-bucket-acl --bucket ${bucket} --region ${region}`,
    'Si falta el bloqueo, activarlo (no lo hace este script):',
    `  aws s3api put-public-access-block --bucket ${bucket} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
    'Para que el diagnóstico corra con las credenciales de la app, sumarle a su política IAM (sólo lectura):',
    '  s3:GetBucketPublicAccessBlock, s3:GetBucketPolicyStatus, s3:GetBucketAcl',
  ].join('\n');
}
