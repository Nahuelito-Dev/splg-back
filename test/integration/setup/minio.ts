/**
 * MinIO efímero para las suites que prueban S3 contra un servicio real.
 * Levanta el contenedor con testcontainers (igual que Postgres y Redis),
 * crea el bucket y deja las variables `AWS_*` listas para la app.
 *
 * La imagen se puede cambiar con `TEST_MINIO_IMAGE`: la oficial de MinIO ya no
 * se publica en Docker Hub ni en Quay, por defecto se usa el build de Chainguard.
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

const IMAGEN_MINIO =
  process.env.TEST_MINIO_IMAGE ?? 'cgr.dev/chainguard/minio:latest';

const USUARIO = 'splgtest';
const CLAVE = 'splgtest-secret';
export const BUCKET_DE_PRUEBA = 'splg-test';

export interface TestMinio {
  container: StartedTestContainer;
  endpoint: string;
  /** Variables `AWS_*` que apuntan la app a este MinIO. */
  env: Record<string, string>;
  client: S3Client;
  stop: () => Promise<void>;
}

export async function startMinio(): Promise<TestMinio> {
  const container = await new GenericContainer(IMAGEN_MINIO)
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: USUARIO,
      MINIO_ROOT_PASSWORD: CLAVE,
      // Sin KMS, MinIO rechaza el cifrado SSE-S3 que manda el back.
      MINIO_KMS_SECRET_KEY:
        'splg-test-key:c3BsZy1kZXYta2V5LW5vLXVzYXItZW4tcHJvZC0xMjM=',
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: USUARIO, secretAccessKey: CLAVE },
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET_DE_PRUEBA }));

  return {
    container,
    endpoint,
    client,
    env: {
      AWS_S3_BUCKET: BUCKET_DE_PRUEBA,
      AWS_REGION: 'us-east-1',
      AWS_S3_ENDPOINT: endpoint,
      AWS_S3_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: USUARIO,
      AWS_SECRET_ACCESS_KEY: CLAVE,
    },
    stop: async () => {
      client.destroy();
      await container.stop();
    },
  };
}
