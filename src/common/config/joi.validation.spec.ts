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

describe('JoiValidationSchema · S3', () => {
  it('sin bucket ni región la app no arranca, y el error dice cuál falta', () => {
    expect(validar({ AWS_REGION: 'sa-east-1' }).error?.message).toContain(
      'AWS_S3_BUCKET es obligatorio',
    );
    expect(validar({ AWS_S3_BUCKET: 'splg' }).error?.message).toContain(
      'AWS_REGION es obligatorio',
    );
  });

  it('bucket y región vacíos cuentan como no definidos', () => {
    const { error } = validar({ AWS_S3_BUCKET: '', AWS_REGION: '' });
    expect(error?.message).toContain('es obligatorio');
  });

  it('bucket y región alcanzan: las credenciales son opcionales (rol IAM)', () => {
    const { error, value } = validar({
      AWS_S3_BUCKET: 'splg',
      AWS_REGION: 'sa-east-1',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_S3_ENDPOINT: '',
    });
    expect(error).toBeUndefined();
    expect(value.AWS_S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('las credenciales van juntas: una sola es un error', () => {
    const { error } = validar({
      AWS_S3_BUCKET: 'splg',
      AWS_REGION: 'sa-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA',
    });
    expect(error).toBeDefined();
  });

  it('acepta el endpoint de MinIO y el direccionamiento por path', () => {
    const { error, value } = validar({
      AWS_S3_BUCKET: 'splg-dev',
      AWS_REGION: 'us-east-1',
      AWS_S3_ENDPOINT: 'http://localhost:9000',
      AWS_S3_FORCE_PATH_STYLE: 'true',
    });
    expect(error).toBeUndefined();
    expect(value.AWS_S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('rechaza un endpoint que no es una URL', () => {
    const { error } = validar({
      AWS_S3_BUCKET: 'splg',
      AWS_REGION: 'sa-east-1',
      AWS_S3_ENDPOINT: 'localhost:9000',
    });
    expect(error).toBeDefined();
  });
});

describe('JoiValidationSchema · antivirus del chat', () => {
  const S3 = { AWS_S3_BUCKET: 'splg', AWS_REGION: 'sa-east-1' };

  it('en producción sin CLAMAV_HOST la app no arranca, y dice cómo apagarlo', () => {
    const { error } = validar({
      ...S3,
      NODE_ENV: 'production',
      CLAMAV_HOST: '',
    });
    expect(error?.message).toContain(
      'CLAMAV_HOST es obligatorio en producción',
    );
    expect(error?.message).toContain('CLAMAV_DISABLED=true');
  });

  it('en producción alcanza el host o el apagado explícito', () => {
    expect(
      validar({ ...S3, NODE_ENV: 'production', CLAMAV_HOST: 'clamav' }).error,
    ).toBeUndefined();
    expect(
      validar({ ...S3, NODE_ENV: 'production', CLAMAV_DISABLED: 'true' }).error,
    ).toBeUndefined();
  });

  it('fuera de producción el host es opcional', () => {
    const { error, value } = validar({ ...S3, NODE_ENV: 'development' });
    expect(error).toBeUndefined();
    expect(value.CLAMAV_DISABLED).toBe(false);
  });
});
