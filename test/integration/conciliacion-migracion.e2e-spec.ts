/**
 * La migración de la conciliación (M6 E3b) sobre una base con lecturas previas,
 * en un Postgres efímero con TODA la cadena de migraciones del repo: lo leído
 * antes queda como ya conciliado (el primer barrido no llena la bandeja), y la
 * vuelta atrás deja las propuestas en `read` y vuelve a correr.
 */
import { randomUUID } from 'crypto';
import { join } from 'path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

const IMAGEN_POSTGIS =
  process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4';

describe('migración de la conciliación de documentos (e2e)', () => {
  let contenedor: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    contenedor = await new PostgreSqlContainer(IMAGEN_POSTGIS)
      .withDatabase('splg_conciliacion')
      .withUsername('test')
      .withPassword('test')
      .start();
    ds = new DataSource({
      type: 'postgres',
      host: contenedor.getHost(),
      port: contenedor.getPort(),
      username: contenedor.getUsername(),
      password: contenedor.getPassword(),
      database: contenedor.getDatabase(),
      migrations: [join(__dirname, '../../src/migrations/*.ts')],
      synchronize: false,
      migrationsTransactionMode: 'each',
    });
    await ds.initialize();
  }, 240000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await contenedor?.stop();
  });

  const columnas = async (): Promise<string[]> => {
    const filas: Array<{ column_name: string }> = await ds.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'document_reading'
         AND column_name IN ('proposal', 'proposal_expires_at', 'reminded_at', 'escalated_at', 'reconciled_at')
       ORDER BY column_name`,
    );
    return filas.map((f) => f.column_name);
  };
  const ultima = async (): Promise<string> => {
    const [{ name }]: Array<{ name: string }> = await ds.query(
      `SELECT name FROM migrations ORDER BY id DESC LIMIT 1`,
    );
    return name;
  };

  it('marca lo leído antes como conciliado, revierte dejando las propuestas en read y vuelve a correr', async () => {
    await ds.runMigrations();
    const final = await ultima();
    // Volver a antes de la conciliación (ésta y las que vinieron después).
    const volverA = async (nombre: string) => {
      while ((await ultima()) !== nombre) await ds.undoLastMigration();
    };
    await volverA('LecturaAutomaticaDeDocumentos1795000000002');
    expect(await columnas()).toEqual([]);

    const [{ distributor_id: dist }]: Array<{ distributor_id: string }> =
      await ds.query(
        `INSERT INTO distributor (name, slug) VALUES ('D', $1) RETURNING distributor_id`,
        [`d-${randomUUID().slice(0, 6)}`],
      );
    await ds.query(
      `INSERT INTO role (type) SELECT 'admin' WHERE NOT EXISTS (SELECT 1 FROM role WHERE type = 'admin')`,
    );
    const [{ user_id: usuario }]: Array<{ user_id: string }> = await ds.query(
      `INSERT INTO "user" (email, full_name, phone_number, firebase_uid, role_id)
       SELECT $1, 'Admin', '+5493764000001', $1, role_id FROM role WHERE type = 'admin' RETURNING user_id`,
      [`mig-${randomUUID().slice(0, 6)}@splg-test.com`],
    );
    const lectura = async (status: string, leida: boolean): Promise<string> => {
      const [{ attachment_id }]: Array<{ attachment_id: string }> =
        await ds.query(
          `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
           VALUES ($1, 'insurance_installment', $2, $3, 'doc', 'application/pdf', 10, $4) RETURNING attachment_id`,
          [dist, randomUUID(), `k/${randomUUID()}`, usuario],
        );
      const [{ reading_id }]: Array<{ reading_id: string }> = await ds.query(
        `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status, attempts, read_at)
         VALUES ($1, $2, $3, $4, 1, $5) RETURNING reading_id`,
        [
          dist,
          attachment_id,
          randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status,
          leida ? new Date() : null,
        ],
      );
      return reading_id;
    };
    const leida = await lectura('read', true);
    const ilegible = await lectura('unreadable', true);
    const fallida = await lectura('failed', false);

    await ds.runMigrations();
    expect(await columnas()).toEqual([
      'escalated_at',
      'proposal',
      'proposal_expires_at',
      'reconciled_at',
      'reminded_at',
    ]);
    const conciliada = async (id: string): Promise<boolean> => {
      const [{ reconciled_at }]: Array<{ reconciled_at: Date | null }> =
        await ds.query(
          `SELECT reconciled_at FROM document_reading WHERE reading_id = $1`,
          [id],
        );
      return reconciled_at !== null;
    };
    expect(await conciliada(leida)).toBe(true);
    expect(await conciliada(ilegible)).toBe(true);
    expect(await conciliada(fallida)).toBe(false);

    // Una propuesta vigente al revertir queda leída (la columna desaparece).
    await ds.query(
      `UPDATE document_reading SET status = 'proposed', proposal = '{"action":"review"}', proposal_expires_at = now() WHERE reading_id = $1`,
      [leida],
    );
    await volverA('LecturaAutomaticaDeDocumentos1795000000002');
    expect(await columnas()).toEqual([]);
    const [{ status }]: Array<{ status: string }> = await ds.query(
      `SELECT status FROM document_reading WHERE reading_id = $1`,
      [leida],
    );
    expect(status).toBe('read');

    await ds.runMigrations();
    expect(await ultima()).toBe(final);
  });
});
