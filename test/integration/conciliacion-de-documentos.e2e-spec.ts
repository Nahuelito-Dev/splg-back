/**
 * Módulo M6, etapa 3b: la conciliación de lo leído con lo que el sistema espera,
 * contra Postgres y Redis reales, con un lector de mentira (sin gastar crédito)
 * y el archivo en el MinIO efímero. La propuesta, su aviso en la bandeja y el
 * ciclo de recordatorio y escalado.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
  CampoLeido,
  DocumentReaderPort,
  LecturaDeDocumento,
} from '../../src/document-reader/document-reader.port';
import { TipoDeDocumento } from '../../src/document-reader/tipos-de-documento';
import { DocumentReadingProposalService } from '../../src/document-reading/document-reading-proposal.service';
import { DocumentReadingRunnerService } from '../../src/document-reading/document-reading-runner.service';
import { DocumentReadingService } from '../../src/document-reading/document-reading.service';
import { S3Service } from '../../src/s3/s3.service';
import { createTestApp, telefonoDePrueba, TestEnv } from './setup/test-env';
import { startMinio, TestMinio } from './setup/minio';

jest.setTimeout(240_000);

const HORA = 3_600_000;

const lecturaDe = (
  tipo: TipoDeDocumento,
  campos: Array<[string, string]>,
  legible = true,
): LecturaDeDocumento => ({
  tipo,
  legible,
  campos: campos.map(
    ([nombre, valor]): CampoLeido => ({ nombre, valor, confianza: 'alta' }),
  ),
  avisos: [],
  uso: {
    modelo: 'claude-opus-5-5',
    tokensDeEntrada: 1000,
    tokensDeSalida: 100,
    costoUsd: 0.01,
  },
});

interface Fila {
  status: string;
  proposal: {
    action: string;
    differences: Array<{ field: string }>;
    summary: string;
  } | null;
  proposal_expires_at: Date | null;
  reminded_at: Date | null;
  escalated_at: Date | null;
}

describe('Conciliación de documentos (M6 E3b, e2e)', () => {
  let env: TestEnv;
  let minio: TestMinio;
  let ds: DataSource;
  let corrida: DocumentReadingRunnerService;
  let propuestas: DocumentReadingProposalService;
  let respuesta: LecturaDeDocumento;
  const leer = jest.fn(() => Promise.resolve(respuesta));
  let dist: string;
  let otra: string;
  let usuario: string;
  let patentes = 100;

  const distribuidora = async (): Promise<string> => {
    const [{ distributor_id }]: Array<{ distributor_id: string }> =
      await ds.query(
        `INSERT INTO distributor (name, slug) VALUES ('D', $1) RETURNING distributor_id`,
        [`d-${randomUUID().slice(0, 6)}`],
      );
    return distributor_id;
  };
  // Una cuota pagada exige caja y comprobante (CHK_insurance_installment_pagada):
  // ese caso lo cubre el unitario del conciliador.
  const cuota = async (distributorId: string): Promise<string> => {
    const [{ insurer_id }]: Array<{ insurer_id: string }> = await ds.query(
      `INSERT INTO insurer (distributor_id, name) VALUES ($1, 'La Segunda Seguros') RETURNING insurer_id`,
      [distributorId],
    );
    const [{ car_id }]: Array<{ car_id: string }> = await ds.query(
      `INSERT INTO car (distributor_id, user_id, car_patent) VALUES ($1, $2, $3) RETURNING car_id`,
      [distributorId, usuario, `AA${String(++patentes).padStart(3, '0')}BB`],
    );
    const [{ policy_id }]: Array<{ policy_id: string }> = await ds.query(
      `INSERT INTO insurance_policy (distributor_id, car_id, insurer_id, policy_number, coverage, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, 'Terceros completo', '2026-01-01', '2027-01-01') RETURNING policy_id`,
      [distributorId, car_id, insurer_id, `P-${randomUUID().slice(0, 6)}`],
    );
    const [{ installment_id }]: Array<{ installment_id: string }> =
      await ds.query(
        `INSERT INTO insurance_installment (distributor_id, policy_id, number, total, due_date, grace_until, amount)
         VALUES ($1, $2, 1, 12, '2026-12-10', '2026-12-20', 150000) RETURNING installment_id`,
        [distributorId, policy_id],
      );
    return installment_id;
  };
  const adjunto = async (owner: string, ownerId: string): Promise<string> => {
    const key = `prueba/${randomUUID()}.pdf`;
    await env.app.get(S3Service).put({
      key,
      body: Buffer.from(`archivo ${key}`),
      contentType: 'application/pdf',
    });
    const [{ attachment_id }]: Array<{ attachment_id: string }> =
      await ds.query(
        `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
         VALUES ($1, $2, $3, $4, 'doc', 'application/pdf', 10, $5) RETURNING attachment_id`,
        [dist, owner, ownerId, key, usuario],
      );
    return attachment_id;
  };
  const fila = async (attachmentId: string): Promise<Fila> => {
    const filas: Fila[] = await ds.query(
      `SELECT status, proposal, proposal_expires_at, reminded_at, escalated_at FROM document_reading WHERE attachment_id = $1`,
      [attachmentId],
    );
    return filas[0];
  };
  /** Los avisos se guardan por un evento: se espera a que aparezcan. */
  const avisos = async (
    esperados: number,
  ): Promise<Array<{ title: string; body: string; email: boolean }>> => {
    let filas: Array<{ title: string; body: string; email: boolean }> = [];
    for (let i = 0; i < 30; i++) {
      filas = await ds.query(
        `SELECT title, body, email FROM admin_notification WHERE distributor_id = $1 AND kind IN ('document_reading_proposal', 'document_reading_notice') ORDER BY created_at`,
        [dist],
      );
      if (filas.length >= esperados) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return filas;
  };
  const pagoDeCuota = (importe: string, fecha = '2026-11-02') =>
    lecturaDe(TipoDeDocumento.COMPROBANTE_DE_PAGO, [
      ['importe', importe],
      ['destinatario', 'LA SEGUNDA SEGUROS S.A.'],
      ['fecha_de_pago', fecha],
    ]);

  beforeAll(async () => {
    minio = await startMinio();
    env = await createTestApp({
      s3: minio.env,
      overrides: [
        { token: DocumentReaderPort, value: { disponible: true, leer } },
      ],
    });
    ds = env.app.get(DataSource);
    corrida = env.app.get(DocumentReadingRunnerService);
    propuestas = env.app.get(DocumentReadingProposalService);
    dist = await distribuidora();
    otra = await distribuidora();
    await ds.query(
      `INSERT INTO role (type) SELECT 'admin' WHERE NOT EXISTS (SELECT 1 FROM role WHERE type = 'admin')`,
    );
    [{ user_id: usuario }] = await ds.query(
      `INSERT INTO "user" (email, full_name, phone_number, firebase_uid, role_id)
       SELECT $1, 'Admin', $2, $1, role_id FROM role WHERE type = 'admin' RETURNING user_id`,
      [`conc-${randomUUID().slice(0, 6)}@splg-test.com`, telefonoDePrueba()],
    );
    await ds.query(
      `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'document_reading', $2)`,
      [
        dist,
        JSON.stringify({
          enabled: 1,
          batchSize: 10,
          monthlyBudgetUsd: 20,
          amountTolerancePct: 1,
          proposalTtlHours: 48,
          reminderTtlHours: 24,
        }),
      ],
    );
  });

  afterAll(async () => {
    await env?.cleanup();
    await minio?.stop();
  });

  beforeEach(async () => {
    leer.mockClear();
    await ds.query(`DELETE FROM document_reading WHERE distributor_id = $1`, [
      dist,
    ]);
    await ds.query(`DELETE FROM attachment WHERE distributor_id = $1`, [dist]);
    await ds.query(`DELETE FROM admin_notification WHERE distributor_id = $1`, [
      dist,
    ]);
  });

  it('un pago de cuota que coincide (antes del vencimiento y dentro de la tolerancia) queda propuesto sin diferencias y avisa', async () => {
    const a = await adjunto('insurance_installment', await cuota(dist));
    respuesta = pagoDeCuota('150900');
    const antes = Date.now();
    await expect(corrida.run(dist)).resolves.toMatchObject({ read: 1 });
    const r = await fila(a);
    expect(r.status).toBe('proposed');
    expect(r.proposal).toMatchObject({
      action: 'pay_installment',
      differences: [],
    });
    const vence = new Date(r.proposal_expires_at as Date).getTime();
    expect(vence).toBeGreaterThanOrEqual(antes + 48 * HORA - 5_000);
    expect(vence).toBeLessThanOrEqual(Date.now() + 48 * HORA);
    const [aviso] = await avisos(1);
    expect(aviso.title).toBe('Propuesta de conciliación pendiente');
    expect(aviso.body).not.toContain('diferencias');
  });

  it('marca el importe fuera de la tolerancia y la fecha futura', async () => {
    const a = await adjunto('insurance_installment', await cuota(dist));
    respuesta = pagoDeCuota('120000', '2099-01-01');
    await corrida.run(dist);
    const r = await fila(a);
    expect(r.proposal?.differences.map((d) => d.field)).toEqual([
      'importe',
      'fecha_de_pago',
    ]);
    const [aviso] = await avisos(1);
    expect(aviso.body).toContain('Hay diferencias para revisar');
  });

  it('una cuota de otra distribuidora no se encuentra: queda para revisar', async () => {
    const a = await adjunto('insurance_installment', await cuota(otra));
    respuesta = pagoDeCuota('150000');
    await corrida.run(dist);
    const r = await fila(a);
    expect(r.status).toBe('proposed');
    expect(r.proposal).toMatchObject({ action: 'review' });
    expect(r.proposal?.summary).toContain('No se encontró la cuota');
  });

  it('un documento de otro tipo que el esperado queda para revisar', async () => {
    const a = await adjunto('insurance_installment', await cuota(dist));
    respuesta = lecturaDe(TipoDeDocumento.POLIZA, [['numero_de_poliza', 'X']]);
    await corrida.run(dist);
    expect((await fila(a)).proposal).toMatchObject({
      action: 'review',
      summary: 'El documento no es lo que se esperaba.',
    });
  });

  it('un documento ilegible avisa que hace falta una imagen mejor y no propone nada', async () => {
    const a = await adjunto('insurance_installment', await cuota(dist));
    respuesta = lecturaDe(TipoDeDocumento.COMPROBANTE_DE_PAGO, [], false);
    await corrida.run(dist);
    const r = await fila(a);
    expect(r.status).toBe('unreadable');
    expect(r.proposal).toBeNull();
    const [aviso] = await avisos(1);
    expect(aviso.body).toContain('subí una imagen mejor');
  });

  it('vencida, recuerda una vez; vencida de nuevo, escala por correo con el impacto; después no repite', async () => {
    const a = await adjunto('insurance_installment', await cuota(dist));
    respuesta = pagoDeCuota('150000');
    await corrida.run(dist);
    await avisos(1);

    // Antes de vencer no pasa nada.
    await expect(
      propuestas.vencerDeDistribuidora(dist, new Date()),
    ).resolves.toEqual({ reminders: 0, escalations: 0 });

    const t1 = new Date(Date.now() + 49 * HORA);
    await expect(propuestas.vencerDeDistribuidora(dist, t1)).resolves.toEqual({
      reminders: 1,
      escalations: 0,
    });
    let r = await fila(a);
    expect(new Date(r.reminded_at as Date).getTime()).toBe(t1.getTime());
    expect(new Date(r.proposal_expires_at as Date).getTime()).toBe(
      t1.getTime() + 24 * HORA,
    );

    // Dentro de la vigencia del recordatorio, todavía no escala.
    await expect(
      propuestas.vencerDeDistribuidora(dist, new Date(t1.getTime() + HORA)),
    ).resolves.toEqual({ reminders: 0, escalations: 0 });

    const t2 = new Date(t1.getTime() + 25 * HORA);
    await expect(propuestas.vencerDeDistribuidora(dist, t2)).resolves.toEqual({
      reminders: 0,
      escalations: 1,
    });
    r = await fila(a);
    expect(r.status).toBe('proposed');
    expect(r.escalated_at).not.toBeNull();
    await expect(
      propuestas.vencerDeDistribuidora(
        dist,
        new Date(t2.getTime() + 99 * HORA),
      ),
    ).resolves.toEqual({ reminders: 0, escalations: 0 });

    const lista = await avisos(3);
    expect(lista.map((x) => x.title)).toEqual([
      'Propuesta de conciliación pendiente',
      'Recordatorio: propuesta pendiente',
      'Propuesta de conciliación escalada',
    ]);
    expect(lista[2].email).toBe(true);
    expect(lista[2].body).toContain(
      'La cuota de $150.000,00 de La Segunda Seguros sigue impaga.',
    );
  });

  it('lo leído al subir el comprobante (fuera de la cola) se concilia en el barrido, con 15 minutos de margen', async () => {
    const a = await adjunto('insurance_installment', await cuota(dist));
    respuesta = pagoDeCuota('150000');
    // Lo mismo que hace el escaneo al subir el comprobante de la cuota.
    await env.app.get(DocumentReadingService).leerAdjunto({
      distributorId: dist,
      attachmentId: a,
      archivo: {
        buffer: Buffer.from(`otro ${a}`),
        mimeType: 'application/pdf',
      },
    });
    expect((await fila(a)).status).toBe('read');
    // Recién leído: el admin puede estar completando el pago a mano.
    await expect(
      propuestas.procesarPendientesDeDistribuidora(dist, new Date()),
    ).resolves.toBe(0);
    expect((await fila(a)).status).toBe('read');
    const despues = new Date(Date.now() + 16 * 60_000);
    await expect(
      propuestas.procesarPendientesDeDistribuidora(dist, despues),
    ).resolves.toBe(1);
    const r = await fila(a);
    expect(r.status).toBe('proposed');
    expect(r.proposal).toMatchObject({ action: 'pay_installment' });
    // Ya conciliada: el barrido no la vuelve a tomar.
    await expect(
      propuestas.procesarPendientesDeDistribuidora(dist, despues),
    ).resolves.toBe(0);
    expect(await avisos(1)).toHaveLength(1);
  });

  it('el mismo comprobante en otra cuota queda duplicado y avisa para no pagar dos veces', async () => {
    const primero = await adjunto('insurance_installment', await cuota(dist));
    const segundo = await adjunto('insurance_installment', await cuota(dist));
    const lector = env.app.get(DocumentReadingService);
    const archivo = {
      buffer: Buffer.from('el mismo PDF'),
      mimeType: 'application/pdf',
    };
    respuesta = pagoDeCuota('150000');
    await lector.leerAdjunto({
      distributorId: dist,
      attachmentId: primero,
      archivo,
    });
    await lector.leerAdjunto({
      distributorId: dist,
      attachmentId: segundo,
      archivo,
    });
    expect((await fila(segundo)).status).toBe('duplicate');
    await propuestas.procesarPendientesDeDistribuidora(
      dist,
      new Date(Date.now() + 16 * 60_000),
    );
    expect((await fila(primero)).status).toBe('proposed');
    expect((await fila(segundo)).status).toBe('duplicate');
    const lista = await avisos(2);
    expect(lista.map((x) => x.title)).toContain('Documento duplicado');
  });

  it('la base no deja una propuesta sin su vigencia ni un estado propuesto sin propuesta', async () => {
    const a = await adjunto('insurance_installment', await cuota(dist));
    respuesta = pagoDeCuota('150000');
    await corrida.run(dist);
    await expect(
      ds.query(
        `UPDATE document_reading SET proposal_expires_at = NULL WHERE attachment_id = $1`,
        [a],
      ),
    ).rejects.toThrow('CHK_document_reading_propuesta');
    await expect(
      ds.query(
        `UPDATE document_reading SET proposal = NULL, proposal_expires_at = NULL, status = 'proposed' WHERE attachment_id = $1`,
        [a],
      ),
    ).rejects.toThrow('CHK_document_reading_propuesta');
    await expect(
      ds.query(
        `UPDATE module_config SET params = params || '{"amountTolerancePct": 25}' WHERE distributor_id = $1 AND module = 'document_reading'`,
        [dist],
      ),
    ).rejects.toThrow('CHK_module_config_lectura');
    await expect(
      ds.query(
        `UPDATE module_config SET params = params || '{"amountTolerancePct": 2.5, "proposalTtlHours": 12}' WHERE distributor_id = $1 AND module = 'document_reading'`,
        [dist],
      ),
    ).resolves.toBeDefined();
    await expect(
      ds.query(
        `UPDATE module_config SET params = params || '{"proposalTtlHours": 1.5}' WHERE distributor_id = $1 AND module = 'document_reading'`,
        [dist],
      ),
    ).rejects.toThrow('CHK_module_config_lectura');
  });
});
