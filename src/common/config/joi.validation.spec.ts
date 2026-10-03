import { JoiValidationSchema } from './joi.validation';

const BASE = {
  DB_PASSWORD: 'x',
  DB_NAME: 'x',
  DB_HOST: 'x',
  DB_USERNAME: 'x',
  FIREBASE_PROJECT_ID: 'x',
  FIREBASE_CLIENT_EMAIL: 'x',
  FIREBASE_PRIVATE_KEY: 'x',
};

function validar(extra: Record<string, string>): {
  error?: Error;
  value: Record<string, unknown>;
} {
  return JoiValidationSchema.validate(
    { ...BASE, ...extra },
    { allowUnknown: true },
  );
}

describe('JoiValidationSchema · almacenamiento', () => {
  it('con el driver local no pide nada de S3, aunque las variables vengan vacías', () => {
    const { error } = validar({
      STORAGE_S3_BUCKET: '',
      STORAGE_S3_REGION: '',
      STORAGE_S3_ACCESS_KEY_ID: '',
      STORAGE_S3_SECRET_ACCESS_KEY: '',
      STORAGE_S3_ENDPOINT: '',
    });
    expect(error).toBeUndefined();
  });

  it('con s3 el bucket es obligatorio y el error lo dice', () => {
    const { error } = validar({
      STORAGE_DRIVER: 's3',
      STORAGE_S3_REGION: 'sa-east-1',
    });
    expect(error?.message).toContain('STORAGE_S3_BUCKET es obligatorio');
  });

  it('con s3 la región es obligatoria, también si viene vacía', () => {
    const { error } = validar({
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'splg',
      STORAGE_S3_REGION: '',
    });
    expect(error?.message).toContain('STORAGE_S3_REGION es obligatorio');
  });

  it('con s3, bucket y región alcanzan: las credenciales son opcionales (rol IAM)', () => {
    const { error, value } = validar({
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'splg',
      STORAGE_S3_REGION: 'sa-east-1',
      STORAGE_S3_ACCESS_KEY_ID: '',
      STORAGE_S3_SECRET_ACCESS_KEY: '',
    });
    expect(error).toBeUndefined();
    expect(value.STORAGE_S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('las credenciales van juntas: una sola es un error', () => {
    const { error } = validar({
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'splg',
      STORAGE_S3_REGION: 'sa-east-1',
      STORAGE_S3_ACCESS_KEY_ID: 'AKIA',
    });
    expect(error).toBeDefined();
  });

  it('acepta el endpoint de MinIO y el direccionamiento por path', () => {
    const { error, value } = validar({
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'splg-dev',
      STORAGE_S3_REGION: 'us-east-1',
      STORAGE_S3_ENDPOINT: 'http://localhost:9000',
      STORAGE_S3_FORCE_PATH_STYLE: 'true',
    });
    expect(error).toBeUndefined();
    expect(value.STORAGE_S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('rechaza un endpoint que no es una URL', () => {
    const { error } = validar({
      STORAGE_DRIVER: 's3',
      STORAGE_S3_BUCKET: 'splg',
      STORAGE_S3_REGION: 'sa-east-1',
      STORAGE_S3_ENDPOINT: 'localhost:9000',
    });
    expect(error).toBeDefined();
  });
});
