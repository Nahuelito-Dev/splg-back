/**
 * Módulo M6, etapa 4a: la decisión del administrador sobre una propuesta,
 * contra Postgres y Redis reales: la compensación cuando el pago falla, dos
 * decisiones a la vez, los CHECK de la decisión y los ejemplos que recibe el
 * lector. El pago que sale bien (egreso en una caja abierta) se prueba en vivo.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
  DocumentReaderPort,
  LecturaDeDocumento,
  OpcionesDeLectura,
} from '../../src/document-reader/document-reader.port';
import { TipoDeDocumento } from '../../src/document-reader/tipos-de-documento';
import { DocumentReadingDecisionService } from '../../src/document-reading/document-reading-decision.service';
import { DocumentReadingService } from '../../src/document-reading/document-reading.service';
import { createTestApp, telefonoDePrueba, TestEnv } from './setup/test-env';

jest.setTimeout(240_000);

const lectura: LecturaDeDocumento = {
  tipo: TipoDeDocumento.COMPROBANTE_DE_PAGO,
  legible: true,
  campos: [{ nombre: 'importe', valor: '100.00', confianza: 'alta' }],
  avisos: [],
  uso: {
    modelo: 'claude-opus-5-5',
    tokensDeEntrada: 10,
    tokensDeSalida: 10,
    costoUsd: 0.001,
  },
};

interface Fila {
  status: string;
  decided_at: Date | null;
  decided_by_user_id: string | null;
  decision_note: string | null;
  corrections: unknown;
  executed: boolean;
  proposal: unknown;
}

describe('Decisión sobre las propuestas de lectura (M6 E4a, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let decisiones: DocumentReadingDecisionService;
  const leer = jest.fn<
    Promise<LecturaDeDocumento>,
    [unknown, OpcionesDeLectura?]
  >(() => Promise.resolve(lectura));
  let dist: string;
  let usuario: string;

  const propuesta = async (
    campos: Array<[string, string]> = [
      ['importe', '29958.00'],
      ['fecha_de_pago', '2026-11-04'],
    ],
  ): Promise<string> => {
    const [{ attachment_id }]: Array<{ attachment_id: string }> =
      await ds.query(
        `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
         VALUES ($1, 'insurance_installment', $2, $3, 'doc', 'application/pdf', 10, $4) RETURNING attachment_id`,
        [dist, randomUUID(), `k/${randomUUID()}`, usuario],
      );
    const [{ reading_id }]: Array<{ reading_id: string }> = await ds.query(
      `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status, detected_type, fields, attempts, read_at, reconciled_at, proposal, proposal_expires_at)
       VALUES ($1, $2, $3, 'proposed', 'comprobante_de_pago', $4, 1, now(), now(), $5, now() + interval '2 days') RETURNING reading_id`,
      [
        dist,
        attachment_id,
        randomUUID().replace(/-/g, '').padEnd(64, '0'),
        JSON.stringify(
          campos.map(([nombre, valor]) => ({
            nombre,
            valor,
            confianza: 'alta',
          })),
        ),
        JSON.stringify({
          action: 'pay_installment',
          ownerType: 'insurance_installment',
          // Una cuota que no existe: el pago falla con 404.
          ownerId: randomUUID(),
          expected: {},
          read: {},
          differences: [],
          summary: 'Comprobante de cuota listo para confirmar.',
        }),
      ],
    );
    return reading_id;
  };
  const fila = async (id: string): Promise<Fila> => {
    const filas: Fila[] = await ds.query(
      `SELECT status, decided_at, decided_by_user_id, decision_note, corrections, executed, proposal FROM document_reading WHERE reading_id = $1`,
      [id],
    );
    return filas[0];
  };

  beforeAll(async () => {
    env = await createTestApp({
      overrides: [
        { token: DocumentReaderPort, value: { disponible: true, leer } },
      ],
    });
    ds = env.app.get(DataSource);
    decisiones = env.app.get(DocumentReadingDecisionService);
    [{ distributor_id: dist }] = await ds.query(
      `INSERT INTO distributor (name, slug) VALUES ('D', $1) RETURNING distributor_id`,
      [`d-${randomUUID().slice(0, 6)}`],
    );
    await ds.query(
      `INSERT INTO role (type) SELECT 'admin' WHERE NOT EXISTS (SELECT 1 FROM role WHERE type = 'admin')`,
    );
    [{ user_id: usuario }] = await ds.query(
      `INSERT INTO "user" (email, full_name, phone_number, firebase_uid, role_id)
       SELECT $1, 'Admin', $2, $1, role_id FROM role WHERE type = 'admin' RETURNING user_id`,
      [`dec-${randomUUID().slice(0, 6)}@splg-test.com`, telefonoDePrueba()],
    );
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('si el pago falla (la cuota no existe), la propuesta vuelve a quedar pendiente y no guarda ejemplos', async () => {
    const id = await propuesta();
    await expect(
      decisiones.corregir(
        id,
        { fields: { importe: '30000.00' }, cashBoxId: randomUUID() },
        dist,
        usuario,
      ),
    ).rejects.toThrow();
    await expect(fila(id)).resolves.toMatchObject({
      status: 'proposed',
      decided_at: null,
      decided_by_user_id: null,
      corrections: null,
      executed: false,
    });
    const [{ n }]: Array<{ n: number }> = await ds.query(
      `SELECT count(*)::int AS n FROM document_reading_example WHERE source_reading_id = $1`,
      [id],
    );
    expect(n).toBe(0);
  });

  it('dos rechazos a la vez: uno decide y el otro recibe 409; la decidida conserva su propuesta', async () => {
    const id = await propuesta();
    const resultados = await Promise.allSettled([
      decisiones.rechazar(id, { reason: 'No es de esta cuota' }, dist, usuario),
      decisiones.rechazar(id, { reason: 'Otro motivo' }, dist, usuario),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const fallido = resultados.find((r) => r.status === 'rejected');
    expect(String(fallido?.reason)).toContain('ya fue resuelta');
    const r = await fila(id);
    expect(r.status).toBe('rejected');
    expect(r.decided_by_user_id).toBe(usuario);
    expect(r.proposal).not.toBeNull();
    // Otra distribuidora no la ve.
    await expect(
      decisiones.rechazar(id, { reason: 'x' }, randomUUID(), usuario),
    ).rejects.toThrow('Lectura no encontrada');
  });

  it('la base no deja una decisión a medias ni un rechazo sin motivo ni una ejecución sin confirmar', async () => {
    const id = await propuesta();
    await expect(
      ds.query(
        `UPDATE document_reading SET status = 'confirmed' WHERE reading_id = $1`,
        [id],
      ),
    ).rejects.toThrow('CHK_document_reading_decision');
    await expect(
      ds.query(
        `UPDATE document_reading SET status = 'rejected', decided_at = now(), decided_by_user_id = $2 WHERE reading_id = $1`,
        [id, usuario],
      ),
    ).rejects.toThrow('CHK_document_reading_rejected_note');
    await expect(
      ds.query(
        `UPDATE document_reading SET status = 'corrected', decided_at = now(), decided_by_user_id = $2 WHERE reading_id = $1`,
        [id, usuario],
      ),
    ).rejects.toThrow('CHK_document_reading_corrected');
    await expect(
      ds.query(
        `UPDATE document_reading SET executed = true WHERE reading_id = $1`,
        [id],
      ),
    ).rejects.toThrow('CHK_document_reading_executed');
  });

  it('el lector recibe las correcciones guardadas del mismo tipo, sin repetir, y de su distribuidora', async () => {
    const id = await propuesta();
    await ds.query(
      `INSERT INTO document_reading_example (distributor_id, document_type, field, read_value, correct_value, source_reading_id)
       VALUES ($1, 'comprobante_de_pago', 'importe', '29958.00', '30000.00', $2),
              ($1, 'comprobante_de_pago', 'destinatario', 'La Segunda', 'Seguros Rivadavia', $2),
              ($1, 'comprobante_de_pago', 'cuit_del_destinatario', '30500065776', '30500065776', $2),
              ($1, 'poliza', 'patente', 'AB12CD', 'AB123CD', $2)`,
      [dist, id],
    );
    const [{ attachment_id }]: Array<{ attachment_id: string }> =
      await ds.query(
        `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
         VALUES ($1, 'insurance_installment', $2, $3, 'doc', 'application/pdf', 10, $4) RETURNING attachment_id`,
        [dist, randomUUID(), `k/${randomUUID()}`, usuario],
      );
    leer.mockClear();
    await env.app.get(DocumentReadingService).leerAdjunto({
      distributorId: dist,
      attachmentId: attachment_id,
      archivo: {
        buffer: Buffer.from(`nuevo ${attachment_id}`),
        mimeType: 'application/pdf',
      },
      opciones: { tipoEsperado: TipoDeDocumento.COMPROBANTE_DE_PAGO },
    });
    const opciones = leer.mock.calls[0][1];
    // Sólo campos de formato, del mismo tipo de documento y con un cambio real:
    // el importe, la aceptación sin cambio y la patente de una póliza no van.
    expect(opciones?.ejemplos).toEqual([
      {
        campo: 'destinatario',
        leido: 'La Segunda',
        correcto: 'Seguros Rivadavia',
      },
    ]);
  });
});
