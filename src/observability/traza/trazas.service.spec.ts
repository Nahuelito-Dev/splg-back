import { NotFoundException } from '@nestjs/common';
import { AdminNotification } from '../../admin-notifications/entities/admin-notification.entity';
import { AuditLog, AuditResult } from '../../audit/entities/audit-log.entity';
import {
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from '../../process-run/domain/process-catalog';
import { ProcessRun } from '../../process-run/entities/process-run.entity';
import { TraceItemKind } from './dto/trace-response.dto';
import { trazasEnMemoria } from './testing/repos-en-memoria';

const ORDEN = '0b8e6c1a-1111-4a2b-9c3d-4e5f6a7b8c9d';

function asiento(p: Partial<AuditLog>): AuditLog {
  return {
    auditId: 'a1',
    distributorId: 'A',
    actorUserId: 'u-a',
    actorRole: 'admin',
    httpMethod: 'PATCH',
    resource: 'orders',
    resourceId: ORDEN,
    path: '/api/v2/orders/:id/status',
    clientSource: 'panel-app',
    ip: '10.0.0.1',
    result: AuditResult.SUCCESS,
    statusCode: 200,
    changes: { receiverName: 'Juan Pérez', phone: '3764000000' },
    errorMessage: null,
    requestId: 'prueba-o1',
    createdAt: new Date('2026-11-14T12:00:00.100Z'),
    ...p,
  };
}

function corrida(p: Partial<ProcessRun>): ProcessRun {
  return {
    runId: 'r1',
    process: ProcessName.PAYMENT_INBOX_PROCESS,
    distributorId: null,
    startedAt: new Date('2026-11-14T12:00:00.050Z'),
    finishedAt: new Date('2026-11-14T12:00:00.462Z'),
    status: ProcessRunStatus.OK,
    counters: { processed: 1 },
    error: null,
    trigger: RunTrigger.WEBHOOK,
    instance: 'h:1',
    traceId: 'prueba-o1',
    requestedBy: null,
    durationMs: 412,
    errorFingerprint: null,
    companies: null,
    ...p,
  };
}

function aviso(p: Partial<AdminNotification>): AdminNotification {
  return {
    notificationId: 'n1',
    distributorId: null,
    kind: 'payment_inbox_failed',
    title: 'Aviso de Juan Pérez sin procesar',
    body: 'Cuerpo con juan@correo.com',
    linkEntity: null,
    linkId: null,
    dedupeKey: 'k',
    email: false,
    emailedAt: null,
    traceId: 'prueba-o1',
    createdAt: new Date('2026-11-14T12:00:00.500Z'),
    ...p,
  };
}

describe('TrazasService (DISENO-OBSERVABILIDAD §7.5)', () => {
  it('une asiento, corrida y aviso de la misma traza, lo más viejo primero', async () => {
    const service = trazasEnMemoria({
      asientos: [asiento({})],
      corridas: [corrida({})],
      avisos: [aviso({})],
    });
    const r = await service.traza('prueba-o1');
    expect(r.traceId).toBe('prueba-o1');
    expect(r.items.map((i) => i.kind)).toEqual([
      TraceItemKind.PROCESS_RUN,
      TraceItemKind.AUDIT,
      TraceItemKind.NOTIFICATION,
    ]);
    expect(r.items[0]).toEqual({
      at: new Date('2026-11-14T12:00:00.050Z'),
      kind: TraceItemKind.PROCESS_RUN,
      summary:
        'Bandeja de avisos de pago: procesamiento — ok (webhook, 412 ms)',
      distributorId: null,
      link: { entity: 'process-run', id: 'r1' },
    });
    expect(r.items[1]).toEqual({
      at: new Date('2026-11-14T12:00:00.100Z'),
      kind: TraceItemKind.AUDIT,
      summary: 'PATCH /api/v2/orders/:id/status → 200 (admin)',
      distributorId: 'A',
      link: { entity: 'orders', id: ORDEN },
    });
    expect(r.items[2]).toMatchObject({
      summary: 'Aviso payment_inbox_failed a la plataforma',
      link: { entity: 'admin-notification', id: 'n1' },
    });
  });

  it('sin datos personales: ni cambios, ni actor, ni ip, ni título o cuerpo del aviso', async () => {
    const service = trazasEnMemoria({
      asientos: [asiento({ resourceId: 'juan@correo.com', resource: 'users' })],
      corridas: [],
      avisos: [aviso({})],
    });
    const texto = JSON.stringify(await service.traza('prueba-o1'));
    for (const prohibido of [
      'Juan',
      'juan@correo.com',
      '3764000000',
      'u-a',
      '10.0.0.1',
    ]) {
      expect(texto).not.toContain(prohibido);
    }
    // Un resourceId que no es uuid (un correo en /users/email/:email) no se enlaza.
    const r = await service.traza('prueba-o1');
    expect(
      r.items.find((i) => i.kind === TraceItemKind.AUDIT)?.link,
    ).toBeNull();
  });

  it('otra distribuidora: la traza de A no lista asientos, corridas ni avisos de B', async () => {
    const service = trazasEnMemoria({
      asientos: [
        asiento({ auditId: 'a-A', requestId: 'traza-a', distributorId: 'A' }),
        asiento({ auditId: 'a-B', requestId: 'traza-b', distributorId: 'B' }),
      ],
      corridas: [
        corrida({ runId: 'r-B', traceId: 'traza-b', distributorId: 'B' }),
      ],
      avisos: [
        aviso({
          notificationId: 'n-A',
          traceId: 'traza-a',
          distributorId: 'A',
        }),
        aviso({
          notificationId: 'n-B',
          traceId: 'traza-b',
          distributorId: 'B',
        }),
      ],
    });
    const a = await service.traza('traza-a');
    expect(a.items.map((i) => i.distributorId)).toEqual(['A', 'A']);
    const b = await service.traza('traza-b');
    expect(b.items).toHaveLength(3);
    expect(b.items.every((i) => i.distributorId !== 'A')).toBe(true);
  });

  it('una corrida en curso no muestra duración', async () => {
    const service = trazasEnMemoria({
      asientos: [],
      corridas: [
        corrida({
          status: ProcessRunStatus.RUNNING,
          finishedAt: null,
          durationMs: null,
          trigger: RunTrigger.CRON,
        }),
      ],
      avisos: [],
    });
    const r = await service.traza('prueba-o1');
    expect(r.items[0].summary).toBe(
      'Bandeja de avisos de pago: procesamiento — running (cron)',
    );
  });

  it('404 TRACE_NOT_FOUND si no hay nada con esa traza', async () => {
    const service = trazasEnMemoria({ asientos: [], corridas: [], avisos: [] });
    const error = await service.traza('nada').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      code: 'TRACE_NOT_FOUND',
    });
  });
});
