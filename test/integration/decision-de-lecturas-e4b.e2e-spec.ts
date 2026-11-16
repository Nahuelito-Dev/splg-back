/** M6 E4b: confirmar/corregir aplica dueños en Postgres, sin mocks de query. */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import { diaArgentino, sumarDias } from '../../src/common/utils/dias-argentina';
import { DocumentReadingDecisionService } from '../../src/document-reading/document-reading-decision.service';
import { DocumentReadingSettingsService } from '../../src/document-reading/document-reading-settings.service';
import { DocumentReadingService } from '../../src/document-reading/document-reading.service';
import { BASE_PLAN_DEFINITIONS } from '../../src/fleet/domain/base-plans';
import {
  MaintenanceDocumentKind,
  MaintenancePlan,
} from '../../src/fleet/entities/maintenance-plan.entity';
import { FleetInsuranceSyncService } from '../../src/fleet/fleet-insurance-sync.service';
import { InsurancePolicyService } from '../../src/insurance/application/insurance-policy.service';
import {
  Caso,
  correrMatriz,
  endpoint,
  Escenario,
  reiniciarCuposDelThrottler,
  sembrarEscenario,
  sembrarPersona,
} from './matriz-http/matriz';
import { createTestApp, TestEnv } from './setup/test-env';

jest.setTimeout(240_000);

type Accion =
  | 'update_policy'
  | 'update_employee_document'
  | 'register_purchase_invoice';

interface Lectura {
  reading_id: string;
  status: string;
  executed: boolean;
}

describe('Decisión de lecturas M6 E4b (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let decisiones: DocumentReadingDecisionService;
  let polizas: InsurancePolicyService;
  let ctx: Escenario;
  let dist: string;
  let distOtra: string;
  let usuario: string;
  let usuarioOtra: string;
  const planes = new Map<string, Record<string, string>>();
  const proveedores = new Map<
    string,
    { supplier: string; warehouse: string }
  >();
  let numeroDeRecepcion = 1;
  const ids: Record<string, string> = {};
  const dia = (n: number): string => sumarDias(diaArgentino(), n);

  const propuesta = async (
    action: Accion,
    ownerType: string,
    ownerId: string,
    fields: Record<string, string>,
    differences: Array<{ field: string; expected: string; read: string }> = [],
    opciones: {
      expected?: Record<string, string | null>;
      detectedType?: string;
    } = {},
  ): Promise<string> => {
    const [{ attachment_id }]: Array<{ attachment_id: string }> =
      await ds.query(
        `INSERT INTO attachment (distributor_id, owner_type, owner_id, storage_key, original_name, mime_type, size_bytes, uploaded_by_user_id)
         VALUES ($1, $2, $3, $4, 'e4b.pdf', 'application/pdf', 10, $5) RETURNING attachment_id`,
        [dist, ownerType, ownerId, `e4b/${randomUUID()}`, usuario],
      );
    const [{ reading_id }]: Array<{ reading_id: string }> = await ds.query(
      `INSERT INTO document_reading (distributor_id, attachment_id, file_sha256, status, detected_type, fields, attempts, read_at, reconciled_at, proposal, proposal_expires_at)
       VALUES ($1, $2, $3, 'proposed', $4, $5, 1, now(), now(), $6, $7) RETURNING reading_id`,
      [
        dist,
        attachment_id,
        randomUUID().replace(/-/g, '').padEnd(64, '0'),
        opciones.detectedType ??
          (action === 'update_policy'
            ? 'poliza'
            : action === 'update_employee_document'
              ? 'apto_medico'
              : 'factura_o_remito'),
        JSON.stringify(
          Object.entries(fields).map(([nombre, valor]) => ({
            nombre,
            valor,
            confianza: 'alta',
          })),
        ),
        JSON.stringify({
          action,
          ownerType,
          ownerId,
          expected: opciones.expected ?? {},
          read: {},
          differences,
          summary: 'Propuesta E4b',
        }),
        new Date(Date.now() + 2 * 86_400_000),
      ],
    );
    return reading_id;
  };

  const lectura = async (id: string): Promise<Lectura> =>
    (
      await ds.query<Lectura[]>(
        `SELECT reading_id, status, executed FROM document_reading WHERE reading_id = $1`,
        [id],
      )
    )[0];

  const sembrarPlanes = async (distribuidora: string): Promise<void> => {
    const porTipo: Record<string, string> = {};
    for (const kind of [
      MaintenanceDocumentKind.INSURANCE,
      MaintenanceDocumentKind.DRIVER_LICENSE,
      MaintenanceDocumentKind.PSYCHOPHYSICAL,
    ]) {
      const definicion = BASE_PLAN_DEFINITIONS.find(
        (d) => d.documentKind === kind,
      );
      const plan = await ds.getRepository(MaintenancePlan).save({
        ...definicion,
        distributorId: distribuidora,
      } as Partial<MaintenancePlan>);
      porTipo[kind] = plan.planId;
    }
    planes.set(distribuidora, porTipo);
    const supplier = randomUUID();
    const warehouse = randomUUID();
    await ds.query(
      `INSERT INTO supplier (supplier_id, distributor_id, business_name, cuit) VALUES ($1, $2, 'Proveedor', '20123456786')`,
      [supplier, distribuidora],
    );
    await ds.query(
      `INSERT INTO warehouse (warehouse_id, distributor_id, name, code) VALUES ($1, $2, 'Depósito', $3)`,
      [warehouse, distribuidora, randomUUID().slice(0, 6).toUpperCase()],
    );
    proveedores.set(distribuidora, { supplier, warehouse });
  };

  const aseguradoraYAuto = async (
    distribuidora: string,
    duenio: string,
  ): Promise<{ insurerId: string; carId: string }> => {
    const [{ insurer_id }]: Array<{ insurer_id: string }> = await ds.query(
      `INSERT INTO insurer (distributor_id, name) VALUES ($1, $2) RETURNING insurer_id`,
      [distribuidora, `Aseguradora ${randomUUID().slice(0, 6)}`],
    );
    const [{ car_id }]: Array<{ car_id: string }> = await ds.query(
      `INSERT INTO car (distributor_id, user_id, car_patent) VALUES ($1, $2, 'AB123CD') RETURNING car_id`,
      [distribuidora, duenio],
    );
    return { insurerId: insurer_id, carId: car_id };
  };

  /** Póliza cargada a mano, sin tarea de flota vinculada. */
  const poliza = async (
    distribuidora = dist,
    duenio = usuario,
  ): Promise<{ policyId: string; carId: string; insurerId: string }> => {
    const { insurerId, carId } = await aseguradoraYAuto(distribuidora, duenio);
    const [{ policy_id }]: Array<{ policy_id: string }> = await ds.query(
      `INSERT INTO insurance_policy (distributor_id, car_id, insurer_id, policy_number, coverage, valid_from, valid_to)
       VALUES ($1, $2, $3, 'VIEJA', 'Terceros', '2026-01-01', '2027-01-01') RETURNING policy_id`,
      [distribuidora, carId, insurerId],
    );
    return { policyId: policy_id, carId, insurerId };
  };

  /** Póliza dada de alta por el servicio real: queda vinculada a la tarea del plan de seguro. */
  const polizaConFlota = async (
    conTareaPrevia = false,
  ): Promise<{
    policyId: string;
    taskId: string;
    previa: string | null;
    desde: string;
    hasta: string;
  }> => {
    const { insurerId, carId } = await aseguradoraYAuto(dist, usuario);
    let previa: string | null = null;
    if (conTareaPrevia) {
      [{ task_id: previa }] = await ds.query(
        `INSERT INTO maintenance_task (plan_id, distributor_id, car_id, status, due_at)
         VALUES ($1, $2, $3, 'scheduled', $4) RETURNING task_id`,
        [
          planes.get(dist)![MaintenanceDocumentKind.INSURANCE],
          dist,
          carId,
          dia(5),
        ],
      );
    }
    const desde = dia(-30);
    const hasta = dia(200);
    const { policyId, fleet } = await polizas.crear(
      {
        carId,
        insurerId,
        policyNumber: `P-${randomUUID().slice(0, 8)}`,
        coverage: 'Terceros',
        validFrom: desde,
        validTo: hasta,
        installments: { count: 3, amount: 100, firstDueDate: dia(10) },
      } as Parameters<InsurancePolicyService['crear']>[0],
      dist,
    );
    expect(fleet.synced).toBe(true);
    return { policyId, taskId: fleet.taskId!, previa, desde, hasta };
  };

  const filaDePoliza = async (id: string) =>
    (
      await ds.query<
        Array<{
          policy_number: string;
          valid_from: string;
          valid_to: string;
          fleet_task_id: string | null;
          fleet_closed_tasks: Array<{ taskId: string; status: string }>;
        }>
      >(
        `SELECT policy_number, valid_from::text, valid_to::text, fleet_task_id, fleet_closed_tasks FROM insurance_policy WHERE policy_id = $1`,
        [id],
      )
    )[0];

  const filaDeTarea = async (id: string) =>
    (
      await ds.query<
        Array<{
          status: string;
          due: string;
          employee_id: string | null;
          delivery_id: string | null;
        }>
      >(
        `SELECT status, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS due, employee_id, delivery_id FROM maintenance_task WHERE task_id = $1`,
        [id],
      )
    )[0];

  const empleado = async (
    distribuidora = dist,
    userId: string | null = null,
  ): Promise<string> => {
    const [{ position_id }]: Array<{ position_id: string }> = await ds.query(
      `INSERT INTO job_position (distributor_id, name, category) VALUES ($1, $2, 'driver') RETURNING position_id`,
      [distribuidora, `Chofer ${randomUUID().slice(0, 6)}`],
    );
    const [{ employee_id }]: Array<{ employee_id: string }> = await ds.query(
      `INSERT INTO employee (distributor_id, position_id, file_number, first_name, last_name, document_type, document_number, hire_date, employment_type, user_id)
       VALUES ($1, $2, $3, 'Ana', 'Prueba', 'dni', $4, '2026-01-01', 'permanent', $5) RETURNING employee_id`,
      [
        distribuidora,
        position_id,
        randomUUID().slice(0, 8),
        randomUUID().slice(0, 8),
        userId,
      ],
    );
    return employee_id;
  };

  const tareaDeEmpleado = async (
    employeeId: string,
    distribuidora = dist,
  ): Promise<string> => {
    const [{ task_id }]: Array<{ task_id: string }> = await ds.query(
      `INSERT INTO maintenance_task (plan_id, distributor_id, employee_id, status, due_at)
       VALUES ($1, $2, $3, 'scheduled', '2026-12-01') RETURNING task_id`,
      [
        planes.get(distribuidora)![MaintenanceDocumentKind.PSYCHOPHYSICAL],
        distribuidora,
        employeeId,
      ],
    );
    return task_id;
  };

  const empleadoConTareas = async (
    cantidad: number,
  ): Promise<{ employeeId: string; taskIds: string[] }> => {
    const employeeId = await empleado();
    const taskIds: string[] = [];
    for (let i = 0; i < cantidad; i++)
      taskIds.push(await tareaDeEmpleado(employeeId));
    return { employeeId, taskIds };
  };

  /** Chofer con la licencia del plan real: la tarea cuelga del perfil de reparto. */
  const choferConLicencia = async (): Promise<{
    employeeId: string;
    deliveryId: string;
    taskId: string;
  }> => {
    const persona = await sembrarPersona(env.app, 'delivery', 'lic', dist);
    const employeeId = await empleado(dist, persona.userId);
    const [{ delivery_id }]: Array<{ delivery_id: string }> = await ds.query(
      `SELECT delivery_id FROM delivery WHERE user_id = $1`,
      [persona.userId],
    );
    const [{ task_id }]: Array<{ task_id: string }> = await ds.query(
      `INSERT INTO maintenance_task (plan_id, distributor_id, delivery_id, status, due_at)
       VALUES ($1, $2, $3, 'scheduled', '2026-12-01') RETURNING task_id`,
      [
        planes.get(dist)![MaintenanceDocumentKind.DRIVER_LICENSE],
        dist,
        delivery_id,
      ],
    );
    return { employeeId, deliveryId: delivery_id, taskId: task_id };
  };

  const recepcion = async (
    distribuidora = dist,
    duenio = usuario,
    tipo = 'delivery_note',
    numero = `R-${randomUUID().slice(0, 8)}`,
  ): Promise<string> => {
    const receiptId = randomUUID();
    const { supplier, warehouse } = proveedores.get(distribuidora)!;
    await ds.query(
      `INSERT INTO purchase_receipt (receipt_id, distributor_id, number, supplier_id, warehouse_id, supplier_document_type, supplier_document_number, received_at, received_by_user_id, total_amount, batch_id) VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, 100, gen_random_uuid())`,
      [
        receiptId,
        distribuidora,
        numeroDeRecepcion++,
        supplier,
        warehouse,
        tipo,
        numero,
        duenio,
      ],
    );
    return receiptId;
  };

  const filaDeRecepcion = async (id: string) =>
    (
      await ds.query<
        Array<{
          supplier_document_type: string;
          supplier_document_number: string;
        }>
      >(
        `SELECT supplier_document_type, supplier_document_number FROM purchase_receipt WHERE receipt_id = $1`,
        [id],
      )
    )[0];

  const anular = (id: string) =>
    ds.query(
      `UPDATE purchase_receipt SET status = 'voided', voided_at = now(), void_reason = 'prueba', voided_by_user_id = $2, void_batch_id = gen_random_uuid() WHERE receipt_id = $1`,
      [id, usuario],
    );

  const sigueSinDecidir = async (id: string) =>
    expect(lectura(id)).resolves.toMatchObject({
      status: 'proposed',
      executed: false,
    });

  const camposDePoliza = (
    numero: string,
    desde: string,
    hasta: string,
  ): Record<string, string> => ({
    numero_de_poliza: numero,
    vigencia_desde: desde,
    vigencia_hasta: hasta,
    patente: 'AB123CD',
  });

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    ds = env.app.get(DataSource);
    decisiones = env.app.get(DocumentReadingDecisionService);
    polizas = env.app.get(InsurancePolicyService);
    ctx = {
      ...(await sembrarEscenario(env.app)),
      reiniciarCupos: () => reiniciarCuposDelThrottler(env),
    };
    dist = ctx.distA.id;
    distOtra = ctx.distB.id;
    usuario = ctx.adminA.userId;
    usuarioOtra = ctx.adminB.userId;
    await sembrarPlanes(dist);
    await sembrarPlanes(distOtra);
  }, 240_000);

  afterAll(async () => env?.cleanup());

  it('el listado trae el adjunto de cada lectura, como la ficha', async () => {
    const { policyId } = await poliza();
    const id = await propuesta('update_policy', 'insurance_policy', policyId, {
      numero_de_poliza: 'LISTADO',
    });
    const { data } = await env.app
      .get(DocumentReadingService)
      .listar(dist, { limit: 100, offset: 0 });
    const fila = data.find((r) => r.readingId === id);
    expect(fila?.attachment).toMatchObject({
      originalName: 'e4b.pdf',
      ownerType: 'insurance_policy',
      ownerId: policyId,
    });
  });

  it('confirmar y corregir póliza actualizan los datos y dejan executed', async () => {
    for (const corregir of [false, true]) {
      const { policyId } = await poliza();
      const id = await propuesta(
        'update_policy',
        'insurance_policy',
        policyId,
        {
          numero_de_poliza: 'CONFIRMADA',
          vigencia_desde: '2026-02-01',
          vigencia_hasta: '2027-02-01',
          patente: 'AB123CD',
        },
      );
      if (corregir)
        await decisiones.corregir(
          id,
          { fields: { numero_de_poliza: 'CORREGIDA' } },
          dist,
          usuario,
        );
      else await decisiones.confirmar(id, {}, dist, usuario);
      await expect(lectura(id)).resolves.toMatchObject({
        status: corregir ? 'corrected' : 'confirmed',
        executed: true,
      });
      const [fila]: Array<{ policy_number: string }> = await ds.query(
        `SELECT policy_number FROM insurance_policy WHERE policy_id = $1`,
        [policyId],
      );
      expect(fila.policy_number).toBe(corregir ? 'CORREGIDA' : 'CONFIRMADA');
    }
  });

  it('patente distinta es 400 y deja la propuesta intacta', async () => {
    const { policyId } = await poliza();
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      {
        numero_de_poliza: 'N',
        vigencia_desde: '2026-02-01',
        vigencia_hasta: '2027-02-01',
        patente: 'ZZ999ZZ',
      },
      [{ field: 'patente', expected: 'AB123CD', read: 'ZZ999ZZ' }],
    );
    await expect(decisiones.confirmar(id, {}, dist, usuario)).rejects.toThrow(
      'Patente',
    );
    await expect(lectura(id)).resolves.toMatchObject({
      status: 'proposed',
      executed: false,
    });
  });

  it('legajo confirma/corrige, permite sin vencimiento y valida tarea ambigua o ajena', async () => {
    const { employeeId, taskIds } = await empleadoConTareas(2);
    const ajeno = await empleadoConTareas(1);
    const id = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: '2027-04-01' },
    );
    await expect(decisiones.confirmar(id, {}, dist, usuario)).rejects.toThrow(
      'elegí cuál renovar',
    );
    await expect(
      decisiones.confirmar(
        id,
        { fleetTaskId: ajeno.taskIds[0] },
        dist,
        usuario,
      ),
    ).rejects.toThrow('no encontrada');
    await decisiones.corregir(
      id,
      { fields: { vencimiento: '2027-05-01' }, fleetTaskId: taskIds[0] },
      dist,
      usuario,
    );
    await expect(lectura(id)).resolves.toMatchObject({
      status: 'corrected',
      executed: true,
    });
    const tareas: Array<{ status: string; due_at: string }> = await ds.query(
      `SELECT status, due_at FROM maintenance_task WHERE employee_id = $1 ORDER BY due_at`,
      [employeeId],
    );
    expect(tareas).toHaveLength(3);
    expect(tareas.some((t) => t.status === 'done')).toBe(true);
    expect(
      tareas.some(
        (t) =>
          t.status !== 'done' &&
          new Date(t.due_at).toISOString().startsWith('2027-05-01'),
      ),
    ).toBe(true);
    const sinVencimiento = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      {},
    );
    await decisiones.confirmar(sinVencimiento, {}, dist, usuario);
    await expect(lectura(sinVencimiento)).resolves.toMatchObject({
      executed: false,
    });
  });

  it('factura confirma y corrige; otra factura no pisa y la misma es idempotente', async () => {
    const receiptId = await recepcion();
    const id = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      receiptId,
      { numero: 'F-1', total: '100.00' },
    );
    await decisiones.confirmar(id, {}, dist, usuario);
    await expect(lectura(id)).resolves.toMatchObject({ executed: true });
    await expect(filaDeRecepcion(receiptId)).resolves.toEqual({
      supplier_document_type: 'invoice',
      supplier_document_number: 'F-1',
    });

    const misma = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      receiptId,
      { numero: 'F-1', total: '100.00' },
    );
    await decisiones.confirmar(misma, {}, dist, usuario);
    await expect(lectura(misma)).resolves.toMatchObject({ executed: true });

    const otra = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      receiptId,
      { numero: 'F-2', total: '100.00' },
    );
    await expect(
      decisiones.confirmar(otra, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 409 });
    await sigueSinDecidir(otra);
    expect((await filaDeRecepcion(receiptId)).supplier_document_number).toBe(
      'F-1',
    );

    const corregida = await recepcion();
    const conDiferencia = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      corregida,
      { numero: 'F-3', total: '99.00' },
      [{ field: 'total', expected: '100.00', read: '99.00' }],
    );
    await decisiones.corregir(
      conDiferencia,
      { fields: { total: '100.00' } },
      dist,
      usuario,
    );
    await expect(lectura(conDiferencia)).resolves.toMatchObject({
      status: 'corrected',
      executed: true,
    });
  });

  it('total: confirmar con diferencia 400; corregido distinto 400; dentro de la tolerancia pasa', async () => {
    const receiptId = await recepcion();
    const malo = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      receiptId,
      { numero: 'T-1', total: '90.00' },
      [{ field: 'total', expected: '100.00', read: '90.00' }],
    );
    await expect(
      decisiones.confirmar(malo, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      decisiones.corregir(malo, { fields: { total: '95.00' } }, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    await sigueSinDecidir(malo);
    expect((await filaDeRecepcion(receiptId)).supplier_document_type).toBe(
      'delivery_note',
    );

    const settings = env.app.get(DocumentReadingSettingsService);
    const espia = jest
      .spyOn(settings, 'parametros')
      .mockResolvedValue({ amountTolerancePct: 2 } as never);
    try {
      const dentro = await propuesta(
        'register_purchase_invoice',
        'purchase_receipt',
        receiptId,
        { numero: 'T-2', total: '101.50' },
      );
      await decisiones.confirmar(dentro, {}, dist, usuario);
      await expect(lectura(dentro)).resolves.toMatchObject({ executed: true });
    } finally {
      espia.mockRestore();
    }
  });

  it('recepción anulada es 409 con rollback', async () => {
    const receiptId = await recepcion();
    await anular(receiptId);
    const id = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      receiptId,
      { numero: 'A-1', total: '100.00' },
    );
    await expect(
      decisiones.confirmar(id, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 409 });
    await sigueSinDecidir(id);
    expect(
      (await filaDeRecepcion(receiptId)).supplier_document_number,
    ).not.toBe('A-1');
  });

  it('un número más largo que su columna es 400, no 500', async () => {
    const receiptId = await recepcion();
    const larga = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      receiptId,
      { numero: 'N'.repeat(31), total: '100.00' },
    );
    await expect(
      decisiones.confirmar(larga, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    await sigueSinDecidir(larga);
    const { policyId } = await poliza();
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('P'.repeat(41), '2026-02-01', '2027-02-01'),
    );
    await expect(
      decisiones.confirmar(id, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    await sigueSinDecidir(id);
  });

  it('dueño de otra distribuidora es 404 con rollback en póliza, tarea y recepción', async () => {
    const ajena = await poliza(distOtra, usuarioOtra);
    const dePoliza = await propuesta(
      'update_policy',
      'insurance_policy',
      ajena.policyId,
      camposDePoliza('N', '2026-02-01', '2027-02-01'),
    );
    await expect(
      decisiones.confirmar(dePoliza, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 404 });
    await sigueSinDecidir(dePoliza);
    expect((await filaDePoliza(ajena.policyId)).policy_number).toBe('VIEJA');

    const recepcionAjena = await recepcion(distOtra, usuarioOtra);
    const deRecepcion = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      recepcionAjena,
      { numero: 'F-9', total: '100.00' },
    );
    await expect(
      decisiones.confirmar(deRecepcion, {}, dist, usuario),
    ).rejects.toThrow('Recepción no encontrada');
    await sigueSinDecidir(deRecepcion);
    expect(
      (await filaDeRecepcion(recepcionAjena)).supplier_document_number,
    ).not.toBe('F-9');

    const propio = await empleadoConTareas(1);
    const empleadoAjeno = await empleado(distOtra);
    const tareaAjena = await tareaDeEmpleado(empleadoAjeno, distOtra);
    const deTarea = await propuesta(
      'update_employee_document',
      'employee',
      propio.employeeId,
      { vencimiento: dia(300) },
    );
    await expect(
      decisiones.confirmar(deTarea, { fleetTaskId: tareaAjena }, dist, usuario),
    ).rejects.toMatchObject({ status: 404 });
    await sigueSinDecidir(deTarea);
    expect((await filaDeTarea(tareaAjena)).status).toBe('scheduled');
    expect((await filaDeTarea(propio.taskIds[0])).status).toBe('scheduled');
  });

  it('dueño cambiado desde la propuesta es 409 con rollback en las tres acciones', async () => {
    const { policyId } = await poliza();
    await ds.query(
      `UPDATE insurance_policy SET policy_number = 'EDITADA' WHERE policy_id = $1`,
      [policyId],
    );
    const dePoliza = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('NUEVA', '2026-02-01', '2027-02-01'),
      [],
      { expected: { numero_de_poliza: 'VIEJA' } },
    );
    await expect(
      decisiones.confirmar(dePoliza, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 409 });
    await sigueSinDecidir(dePoliza);
    expect((await filaDePoliza(policyId)).policy_number).toBe('EDITADA');

    const receiptId = await recepcion();
    const deRecepcion = await propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      receiptId,
      { numero: 'C-1', total: '100.00' },
      [],
      { expected: { total: '250.00' } },
    );
    await expect(
      decisiones.confirmar(deRecepcion, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 409 });
    await sigueSinDecidir(deRecepcion);

    const { employeeId, taskIds } = await empleadoConTareas(1);
    const deLegajo = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(300) },
      [],
      { expected: { documento: '99999999' } },
    );
    await expect(
      decisiones.confirmar(deLegajo, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 409 });
    await sigueSinDecidir(deLegajo);
    expect((await filaDeTarea(taskIds[0])).status).toBe('scheduled');
  });

  it('si falla al aplicar la póliza, revierte el reclamo y los datos del dueño', async () => {
    const { policyId } = await poliza();
    const id = await propuesta('update_policy', 'insurance_policy', policyId, {
      numero_de_poliza: 'NO-DEBE-QUEDAR',
      vigencia_desde: '2027-02-01',
      vigencia_hasta: '2026-02-01',
      patente: 'AB123CD',
    });
    await expect(decisiones.confirmar(id, {}, dist, usuario)).rejects.toThrow(
      'Válido hasta',
    );
    await expect(lectura(id)).resolves.toMatchObject({
      status: 'proposed',
      executed: false,
    });
    const [p]: Array<{ policy_number: string }> = await ds.query(
      `SELECT policy_number FROM insurance_policy WHERE policy_id = $1`,
      [policyId],
    );
    expect(p.policy_number).toBe('VIEJA');
  });

  it('rollback provocado después de escribir la póliza: el dueño no cambia', async () => {
    const { policyId, taskId, hasta } = await polizaConFlota();
    const antes = await filaDePoliza(policyId);
    const sync = env.app.get(FleetInsuranceSyncService);
    const espia = jest
      .spyOn(sync, 'recalcularVencimiento')
      .mockRejectedValue(new Error('falla provocada'));
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('NO-DEBE-QUEDAR', dia(-30), dia(150)),
    );
    try {
      await expect(
        decisiones.confirmar(id, {}, dist, usuario),
      ).rejects.toBeDefined();
      expect(espia).toHaveBeenCalled();
    } finally {
      espia.mockRestore();
    }
    await sigueSinDecidir(id);
    await expect(filaDePoliza(policyId)).resolves.toEqual(antes);
    expect((await filaDeTarea(taskId)).due).toBe(hasta);
  });

  it('corregir la póliza a una fecha anterior mueve su tarea y conserva el vínculo', async () => {
    const { policyId, taskId, desde } = await polizaConFlota();
    const nueva = dia(150);
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('MOVIDA', desde, nueva),
    );
    await decisiones.confirmar(id, {}, dist, usuario);
    await expect(lectura(id)).resolves.toMatchObject({ executed: true });
    const fila = await filaDePoliza(policyId);
    expect(fila.fleet_task_id).toBe(taskId);
    expect(fila.valid_to).toBe(nueva);
    await expect(filaDeTarea(taskId)).resolves.toMatchObject({
      status: 'scheduled',
      due: nueva,
    });
  });

  it('si la tarea de la póliza ya está cerrada, crea el control de vencimiento', async () => {
    const { policyId, taskId, desde } = await polizaConFlota();
    await ds.query(
      `UPDATE maintenance_task SET status = 'cancelled' WHERE task_id = $1`,
      [taskId],
    );
    const nueva = dia(200);
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('SIN-TAREA', desde, nueva),
    );
    await decisiones.confirmar(id, {}, dist, usuario);
    await expect(lectura(id)).resolves.toMatchObject({ executed: true });
    const fila = await filaDePoliza(policyId);
    expect(fila.fleet_task_id).not.toBe(taskId);
    expect(fila.fleet_task_id).toBeTruthy();
    await expect(filaDeTarea(fila.fleet_task_id!)).resolves.toMatchObject({
      status: 'scheduled',
      due: nueva,
    });
  });

  it('extender conserva las tareas cerradas y cancelar reabre la original', async () => {
    const { policyId, taskId, previa, desde } = await polizaConFlota(true);
    const antes = await filaDePoliza(policyId);
    expect(antes.fleet_closed_tasks.map((t) => t.taskId)).toEqual([previa]);
    const nueva = dia(260);
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('EXTENDIDA', desde, nueva),
    );
    await decisiones.confirmar(id, {}, dist, usuario);
    const fila = await filaDePoliza(policyId);
    expect(fila.fleet_task_id).toBe(taskId);
    expect(fila.fleet_closed_tasks).toEqual(antes.fleet_closed_tasks);
    expect((await filaDeTarea(taskId)).due).toBe(nueva);

    await polizas.cancelar(policyId, { reason: 'prueba' }, dist);
    expect((await filaDeTarea(taskId)).status).toBe('cancelled');
    expect((await filaDeTarea(previa!)).status).toBe('scheduled');
  });

  it('una vigencia que deja cuotas afuera es 400 y no toca nada', async () => {
    const { policyId, taskId, desde, hasta } = await polizaConFlota();
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('CORTA', desde, dia(20)),
    );
    await expect(
      decisiones.confirmar(id, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    await sigueSinDecidir(id);
    expect((await filaDePoliza(policyId)).valid_to).toBe(hasta);
    expect((await filaDeTarea(taskId)).due).toBe(hasta);
  });

  it('aseguradora dada de baja no impide actualizar la póliza', async () => {
    const { policyId, insurerId } = await poliza();
    await ds.query(
      `UPDATE insurer SET "deletedAt" = now() WHERE insurer_id = $1`,
      [insurerId],
    );
    const id = await propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      camposDePoliza('BAJA', '2026-02-01', dia(200)),
    );
    await decisiones.confirmar(id, {}, dist, usuario);
    await expect(lectura(id)).resolves.toMatchObject({ executed: true });
  });

  it('licencia del plan real: renueva por el perfil de reparto y vincula el adjunto', async () => {
    const { employeeId, deliveryId, taskId } = await choferConLicencia();
    const id = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(700) },
      [],
      { detectedType: 'licencia_de_conducir' },
    );
    await decisiones.confirmar(id, {}, dist, usuario);
    await expect(lectura(id)).resolves.toMatchObject({ executed: true });
    expect((await filaDeTarea(taskId)).status).toBe('done');
    const nuevas: Array<{
      employee_id: string | null;
      delivery_id: string;
      due: string;
    }> = await ds.query(
      `SELECT employee_id, delivery_id, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS due
       FROM maintenance_task WHERE delivery_id = $1 AND status = 'scheduled'`,
      [deliveryId],
    );
    expect(nuevas).toEqual([
      { employee_id: null, delivery_id: deliveryId, due: dia(700) },
    ]);
    const adjuntos: unknown[] = await ds.query(
      `SELECT 1 FROM maintenance_task_attachment WHERE task_id = $1`,
      [taskId],
    );
    expect(adjuntos).toHaveLength(1);
  });

  it('legajo: no apto, documento distinto, vencimiento pasado, vigencia y egresado no renuevan', async () => {
    const { employeeId, taskIds } = await empleadoConTareas(1);
    const noApto = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(300), resultado: 'no apto' },
    );
    await expect(
      decisiones.confirmar(noApto, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    const documento = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(300), documento: '11111111' },
      [{ field: 'documento', expected: '22222222', read: '11111111' }],
    );
    await expect(
      decisiones.confirmar(documento, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      decisiones.corregir(
        documento,
        { fields: { documento: '22222222' } },
        dist,
        usuario,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const pasado = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(-1) },
    );
    await expect(
      decisiones.confirmar(pasado, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    const incoherente = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(10), fecha: dia(20) },
    );
    await expect(
      decisiones.confirmar(incoherente, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 400 });
    for (const r of [noApto, documento, pasado, incoherente])
      await sigueSinDecidir(r);
    expect((await filaDeTarea(taskIds[0])).status).toBe('scheduled');

    await ds.query(
      `UPDATE employee SET status = 'terminated', termination_date = '2026-06-01' WHERE employee_id = $1`,
      [employeeId],
    );
    const egresado = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(300) },
    );
    await expect(
      decisiones.confirmar(egresado, {}, dist, usuario),
    ).rejects.toMatchObject({ status: 409 });
    await sigueSinDecidir(egresado);
  });

  it('una tarea elegida que ya está cerrada es 409 con mensaje claro', async () => {
    const { employeeId, taskIds } = await empleadoConTareas(1);
    await ds.query(
      `UPDATE maintenance_task SET status = 'done', performed_at = now() WHERE task_id = $1`,
      [taskIds[0]],
    );
    const id = await propuesta(
      'update_employee_document',
      'employee',
      employeeId,
      { vencimiento: dia(300) },
    );
    await expect(
      decisiones.confirmar(id, { fleetTaskId: taskIds[0] }, dist, usuario),
    ).rejects.toThrow('ya está hecha');
    await sigueSinDecidir(id);
  });

  const lecturaDePoliza = async (
    campos?: Record<string, string>,
    diferencias: Array<{ field: string; expected: string; read: string }> = [],
    expected?: Record<string, string | null>,
  ): Promise<string> => {
    const { policyId } = await poliza();
    return propuesta(
      'update_policy',
      'insurance_policy',
      policyId,
      campos ??
        camposDePoliza(`M-${randomUUID().slice(0, 6)}`, '2026-02-01', dia(200)),
      diferencias,
      { expected },
    );
  };
  const lecturaDeFactura = async (
    campos: Record<string, string> = {
      numero: `M-${randomUUID().slice(0, 6)}`,
      total: '100.00',
    },
    diferencias: Array<{ field: string; expected: string; read: string }> = [],
  ): Promise<string> =>
    propuesta(
      'register_purchase_invoice',
      'purchase_receipt',
      await recepcion(),
      campos,
      diferencias,
    );
  const preparar =
    (armar: () => Promise<string>) => async (): Promise<void> => {
      ids.actual = await armar();
    };
  const yaResuelta = async (): Promise<string> => {
    const id = await lecturaDeFactura();
    await decisiones.confirmar(id, {}, dist, usuario);
    return id;
  };
  const rutaDe = (accion: string) => (): string =>
    `/v2/document-readings/${ids.actual}/${accion}`;
  const inexistente =
    (accion: string) =>
    (c: Escenario): string =>
      `/v2/document-readings/${c.inexistente}/${accion}`;
  const quedaEjecutada = (cuerpo: unknown): void => {
    expect(cuerpo).toMatchObject({ executed: true });
  };
  const confirm = endpoint<Escenario>(
    'post',
    '/v2/document-readings/{id}/confirm',
    rutaDe('confirm'),
  );
  const correct = endpoint<Escenario>(
    'post',
    '/v2/document-readings/{id}/correct',
    rutaDe('correct'),
  );
  const diferenciaDeTotal = [
    { field: 'total', expected: '100.00', read: '90.00' },
  ];
  const casos: Array<Caso<Escenario>> = [
    confirm('póliza', 'adminA', 200, {
      antes: preparar(() => lecturaDePoliza()),
      verificar: quedaEjecutada,
    }),
    confirm('factura', 'adminA', 200, {
      antes: preparar(() => lecturaDeFactura()),
      verificar: quedaEjecutada,
    }),
    confirm('id mal formado', 'adminA', 400, {
      ruta: '/v2/document-readings/no-es-uuid/confirm',
    }),
    confirm('campo extra', 'adminA', 400, {
      antes: preparar(() => lecturaDeFactura()),
      body: { ajeno: true },
    }),
    confirm('tarea que no es uuid', 'adminA', 400, {
      antes: preparar(() => lecturaDeFactura()),
      body: { fleetTaskId: 'no-es-uuid' },
    }),
    confirm('patente distinta', 'adminA', 400, {
      antes: preparar(() =>
        lecturaDePoliza(undefined, [
          { field: 'patente', expected: 'AB123CD', read: 'ZZ999ZZ' },
        ]),
      ),
      mensaje: 'rechazá la propuesta',
    }),
    confirm('total distinto', 'adminA', 400, {
      antes: preparar(() =>
        lecturaDeFactura({ numero: 'M-T', total: '90.00' }, diferenciaDeTotal),
      ),
    }),
    confirm('super sin sesión de soporte', 'super', 403, {
      ruta: inexistente('confirm'),
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    confirm('super en modo soporte (sólo lectura)', 'soporteA', 403, {
      ruta: inexistente('confirm'),
      code: 'SUPPORT_READ_ONLY',
    }),
    confirm('sin token', undefined, 401, { ruta: inexistente('confirm') }),
    confirm('cliente', 'clienteA', 403, { ruta: inexistente('confirm') }),
    confirm('chofer', 'chofer', 403, { ruta: inexistente('confirm') }),
    confirm('lectura inexistente', 'adminA', 404, {
      ruta: inexistente('confirm'),
    }),
    confirm('lectura de otra distribuidora', 'adminB', 404, {
      antes: preparar(() => lecturaDeFactura()),
    }),
    confirm('ya resuelta', 'adminA', 409, {
      antes: preparar(yaResuelta),
      mensaje: 'ya fue resuelta',
    }),
    confirm('dueño cambiado', 'adminA', 409, {
      antes: preparar(() =>
        lecturaDePoliza(undefined, [], { numero_de_poliza: 'OTRO-NUMERO' }),
      ),
    }),
    correct('factura con total aceptado', 'adminA', 200, {
      antes: preparar(() =>
        lecturaDeFactura({ numero: 'M-C', total: '90.00' }, diferenciaDeTotal),
      ),
      body: { fields: { total: '100.00' } },
      verificar: quedaEjecutada,
    }),
    correct('sin campos', 'adminA', 400, {
      antes: preparar(() => lecturaDeFactura()),
      body: {},
    }),
    correct('campo ajeno al documento', 'adminA', 400, {
      antes: preparar(() => lecturaDeFactura()),
      body: { fields: { patente: 'AB123CD' } },
    }),
    correct('total corregido distinto', 'adminA', 400, {
      antes: preparar(() =>
        lecturaDeFactura({ numero: 'M-D', total: '90.00' }, diferenciaDeTotal),
      ),
      body: { fields: { total: '95.00' } },
    }),
    correct('super sin sesión de soporte', 'super', 403, {
      ruta: inexistente('correct'),
      body: { fields: { total: '100.00' } },
      code: 'SUPPORT_SESSION_REQUIRED',
    }),
    correct('sin token', undefined, 401, {
      ruta: inexistente('correct'),
      body: { fields: { total: '100.00' } },
    }),
    correct('cliente', 'clienteA', 403, {
      ruta: inexistente('correct'),
      body: { fields: { total: '100.00' } },
    }),
    correct('chofer', 'chofer', 403, {
      ruta: inexistente('correct'),
      body: { fields: { total: '100.00' } },
    }),
    correct('lectura inexistente', 'adminA', 404, {
      ruta: inexistente('correct'),
      body: { fields: { total: '100.00' } },
    }),
    correct('lectura de otra distribuidora', 'adminB', 404, {
      antes: preparar(() => lecturaDeFactura()),
      body: { fields: { total: '100.00' } },
    }),
    correct('ya resuelta', 'adminA', 409, {
      antes: preparar(yaResuelta),
      body: { fields: { numero: 'M-X' } },
      mensaje: 'ya fue resuelta',
    }),
    correct('recepción anulada', 'adminA', 409, {
      antes: async () => {
        const receiptId = await recepcion();
        await anular(receiptId);
        ids.actual = await propuesta(
          'register_purchase_invoice',
          'purchase_receipt',
          receiptId,
          { numero: 'M-A', total: '100.00' },
        );
      },
      body: { fields: { numero: 'M-B' } },
    }),
  ];
  correrMatriz('confirmar y corregir por HTTP', () => ctx, casos);
});
