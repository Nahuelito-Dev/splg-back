/**
 * Saldo inicial de la cuenta de envases (F35 E2): para cada distribuidora,
 * cliente y tipo, la mayor cantidad de ese tipo en un mismo pedido entregado.
 * Idempotente: una cuenta recibe su saldo inicial una sola vez.
 *
 *   npm run envases:saldo-inicial
 */
import 'dotenv/config';
import './lib/marcar-script';
import { DataSource } from 'typeorm';
import { CustomerContainerService } from '../src/customer-container/customer-container.service';

async function main(): Promise<void> {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    synchronize: false,
    extra: { application_name: process.env.DB_APP_NAME },
  });
  await ds.initialize();
  try {
    await ds.transaction((manager) =>
      new CustomerContainerService({
        habilitado: async () => false,
      } as never).inicializarSaldoDesdeEntregas(manager),
    );
    console.log(
      'Saldo inicial de envases procesado para todas las distribuidoras.',
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(
    'envases:saldo-inicial falló:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
