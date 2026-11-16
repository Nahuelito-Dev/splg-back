/**
 * Módulo M6, etapa 4a: la decisión que paga de verdad, contra Postgres real.
 * Cuota, póliza, aseguradora y una caja de banco sembradas; la decisión toma la
 * propuesta, registra el pago con su egreso y marca la lectura ejecutada en una
 * sola transacción. Si algo falla después del egreso, no queda nada.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import { DocumentReadingDecisionService } from '../../src/document-reading/document-reading-decision.service';
import { createTestApp, telefonoDePrueba, TestEnv } from './setup/test-env';

jest.setTimeout(240_000);

interface Cuota {
  status: string;
  paid_amount: string | null;
  cash_movement_id: string | null;
  operation_number: string | null;
}

describe('Decisión que paga (M6 E4a, e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let decisiones: DocumentReadingDecisionService;
  let dist: string;
  let usuario: string;
  let banco: string;
  let patentes = 200;

  /** Una cuota pendiente de $29.958 con su comprobante y una propuesta sobre él. */
  const escenario = async (
    leido: string,
    diferencias: Array<{ field: string; expected: string; read: string }>,
  ): Promise<{ lectura: string; cuota: string }> => {
    const [{ insurer_id }]: Array<{ insurer_id: string }> = await ds.query(
      `INSERT INTO insurer (distributor_id, name) VALUES ($1, 'Seguros Rivadavia') RETURNING insurer_id`,
      [dist],
    );
    const [{ car_id }]: Array<{ car_id: string }> = await ds.query(
      `INSERT INTO car (distributor_id, user_id, car_patent) VALUES ($1, $2, $3) RETURNING car_id`,
      [dist, usuario, `AC${String(++patentes).padStart(3, '0')}DE`],
    );
    const [{ policy_id }]: Array<{ policy_id: string }> = await ds.query(
      `INSERT INTO insurance_policy (distributor_id, car_id, insurer_id, policy_number, coverage, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, 'Terceros completo', '2026-01-01', '2027-01-01') RETURNING policy_id`,
      [dist, car_id, insurer_id, `P-${randomUUID().slice(0, 6)}`],
    );
    const [{ installment_id: cuota }]: Array<{ installment_id: string }> =
      await ds.query(
        `INSERT INTO insurance_installment (distributor_id, policy_id, number, total, due_date, grace_until, amount)
         VALUES ($1, $2, 1, 12, '2026-12-10', '2026-12-20', 29958) RETURNING installment_id`,
        [dist, policy_id],
      );
    const [{ attachment_id }]: Array<{ attachment_id: string }> =
      await ds.query(
        `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
         VALUES ($1, 'insurance_installment', $2, $3, 'comprobante', 'application/pdf', 10, $4) RETURNING attachment_id`,
        [dist, cuota, `k/${randomUUID()}`, usuario],
      );
    const campos = [
      ['importe', leido],
      ['fecha_de_pago', '2026-11-04'],
      ['numero_de_operacion', '556677001'],
      ['destinatario', 'Rivadavia'],
    ].map(([nombre, valor]) => ({ nombre, valor, confianza: 'alta' }));
    const [{ reading_id: lectura }]: Array<{ reading_id: string }> =
      await ds.query(
        `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status, detected_type, fields, attempts, read_at, reconciled_at, proposal, proposal_expires_at)
         VALUES ($1, $2, $3, 'proposed', 'comprobante_de_pago', $4, 1, now(), now(), $5, now() + interval '2 days') RETURNING reading_id`,
        [
          dist,
          attachment_id,
          randomUUID().replace(/-/g, '').padEnd(64, '0'),
          JSON.stringify(campos),
          JSON.stringify({
            action: 'pay_installment',
            ownerType: 'insurance_installment',
            ownerId: cuota,
            expected: { importe: '29958.00' },
            read: { importe: leido },
            differences: diferencias.map((d) => ({
              ...d,
              message: 'El importe del comprobante difiere del esperado',
            })),
            summary: 'Revisá las diferencias del comprobante de la cuota.',
          }),
        ],
      );
    return { lectura, cuota };
  };
  const cuotaDe = async (id: string): Promise<Cuota> => {
    const [c]: Cuota[] = await ds.query(
      `SELECT status, paid_amount, cash_movement_id, operation_number FROM insurance_installment WHERE installment_id = $1`,
      [id],
    );
    return c;
  };
  const lecturaDe = async (
    id: string,
  ): Promise<{ status: string; executed: boolean; corrections: unknown }> => {
    const [l]: Array<{
      status: string;
      executed: boolean;
      corrections: unknown;
    }> = await ds.query(
      `SELECT status, executed, corrections FROM document_reading WHERE reading_id = $1`,
      [id],
    );
    return l;
  };
  const egresos = async (cuota: string): Promise<number> => {
    const [{ n }]: Array<{ n: number }> = await ds.query(
      `SELECT count(*)::int AS n FROM cash_movement WHERE reference_id = $1`,
      [cuota],
    );
    return n;
  };

  beforeAll(async () => {
    env = await createTestApp();
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
      [`pago-${randomUUID().slice(0, 6)}@splg-test.com`, telefonoDePrueba()],
    );
    [{ cash_box_id: banco }] = await ds.query(
      `INSERT INTO cash_box (distributor_id, name, kind, balance, requires_session) VALUES ($1, 'Banco', 'bank', 0, false) RETURNING cash_box_id`,
      [dist],
    );
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('con diferencia en el importe: confirmar y corregir otro dato dan 400; corregir el importe paga con el egreso', async () => {
    const { lectura, cuota } = await escenario('35000.00', [
      { field: 'importe', expected: '29958.00', read: '35000.00' },
    ]);
    await expect(
      decisiones.confirmar(lectura, { cashBoxId: banco }, dist, usuario),
    ).rejects.toThrow('Hay diferencias en el importe');
    await expect(
      decisiones.corregir(
        lectura,
        { fields: { destinatario: 'Seguros Rivadavia' }, cashBoxId: banco },
        dist,
        usuario,
      ),
    ).rejects.toThrow('indicá el importe correcto');
    await expect(cuotaDe(cuota)).resolves.toMatchObject({ status: 'pending' });

    await decisiones.corregir(
      lectura,
      { fields: { importe: '29958' }, cashBoxId: banco },
      dist,
      usuario,
    );
    await expect(cuotaDe(cuota)).resolves.toMatchObject({
      status: 'paid',
      paid_amount: '29958.00',
      operation_number: '556677001',
    });
    expect(await egresos(cuota)).toBe(1);
    await expect(lecturaDe(lectura)).resolves.toMatchObject({
      status: 'corrected',
      executed: true,
    });
  });

  it('aceptar el importe leído (recargo) paga lo leído y queda como corrección explícita', async () => {
    const { lectura, cuota } = await escenario('31000.00', [
      { field: 'importe', expected: '29958.00', read: '31000.00' },
    ]);
    await decisiones.corregir(
      lectura,
      { fields: { importe: '31000.0' }, cashBoxId: banco },
      dist,
      usuario,
    );
    await expect(cuotaDe(cuota)).resolves.toMatchObject({
      status: 'paid',
      paid_amount: '31000.00',
    });
    const l = await lecturaDe(lectura);
    expect(l).toMatchObject({ status: 'corrected', executed: true });
    expect(l.corrections).toEqual([
      { field: 'importe', read: '31000.00', value: '31000.00' },
    ]);
  });

  it('si algo falla después del egreso, se revierte todo: la cuota sigue impaga, sin movimiento y la propuesta pendiente', async () => {
    const { lectura, cuota } = await escenario('29958.00', []);
    // Un ejemplo ya guardado para el mismo campo hace fallar el alta de los ejemplos,
    // que corre después del pago dentro de la misma transacción.
    await ds.query(
      `INSERT INTO document_reading_example (distributor_id, document_type, field, read_value, correct_value, source_reading_id)
       VALUES ($1, 'comprobante_de_pago', 'destinatario', 'Rivadavia', 'Otro', $2)`,
      [dist, lectura],
    );
    await expect(
      decisiones.corregir(
        lectura,
        { fields: { destinatario: 'Seguros Rivadavia' }, cashBoxId: banco },
        dist,
        usuario,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(cuotaDe(cuota)).resolves.toMatchObject({
      status: 'pending',
      paid_amount: null,
      cash_movement_id: null,
    });
    expect(await egresos(cuota)).toBe(0);
    await expect(lecturaDe(lectura)).resolves.toMatchObject({
      status: 'proposed',
      executed: false,
    });
  });
});
