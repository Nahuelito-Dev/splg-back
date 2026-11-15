import {
  Body,
  Controller,
  INestApplication,
  Logger,
  Param,
  Patch,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  EventEmitter2,
  EventEmitterModule,
  OnEvent,
} from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { AdminNotification } from '../../admin-notifications/entities/admin-notification.entity';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import type { AuditService, NuevoAsiento } from '../../audit/audit.service';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import {
  EVENTO_NOTIFICAR_ADMIN,
  NotificarAdminEvent,
} from '../../common/events/notificar-admin.event';
import { requestIdMiddleware } from '../../common/middleware/request-id.middleware';
import { LoggerConTraza } from '../../common/traza/logger-con-traza';
import {
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from '../../process-run/domain/process-catalog';
import { ProcessRun } from '../../process-run/entities/process-run.entity';
import { conDisparo } from '../../process-run/process-run.context';
import { ProcessRunRecorder } from '../../process-run/process-run.recorder';
import { TraceItemKind } from './dto/trace-response.dto';
import { trazasEnMemoria } from './testing/repos-en-memoria';

const asientos: AuditLog[] = [];
const corridas: ProcessRun[] = [];
const avisos: AdminNotification[] = [];

/** Las corridas se guardan en memoria con lo que el registrador inserta y cierra. */
function repoDeCorridas(): Repository<ProcessRun> {
  let pendiente: Partial<ProcessRun> = {};
  let accion: 'insert' | 'update' = 'insert';
  let donde = '';
  const qb = {
    insert: () => ((accion = 'insert'), qb),
    update: () => ((accion = 'update'), qb),
    values: (v: Partial<ProcessRun>) => ((pendiente = v), qb),
    set: (v: Partial<ProcessRun>) => ((pendiente = v), qb),
    where: (_sql: string, p: { runId: string }) => ((donde = p.runId), qb),
    execute: () => {
      if (accion === 'insert') {
        corridas.push(pendiente as ProcessRun);
      } else {
        const fila = corridas.find((c) => c.runId === donde);
        if (fila) {
          // `finishedAt` llega como SQL (`GREATEST(now(), …)`): acá vale ahora.
          Object.assign(fila, pendiente, { finishedAt: new Date() });
        }
      }
      return Promise.resolve({ identifiers: [] });
    },
  };
  return { createQueryBuilder: () => qb } as unknown as Repository<ProcessRun>;
}

const recorder = new ProcessRunRecorder(repoDeCorridas());

/** Lo que haría el listener de la bandeja: guarda el aviso con la traza que trae el evento. */
class BandejaDePrueba {
  @OnEvent(EVENTO_NOTIFICAR_ADMIN, { async: true })
  async guardar(evento: NotificarAdminEvent): Promise<void> {
    await new Promise((r) => setTimeout(r, 1));
    avisos.push({
      notificationId: `n-${avisos.length + 1}`,
      distributorId: evento.distributorId,
      kind: evento.kind,
      traceId: evento.traceId,
      createdAt: new Date(),
    } as AdminNotification);
  }
}

/** Un endpoint de escritura que tarda, dispara una corrida y pide un aviso. */
@Controller('prueba')
class PruebaController {
  private readonly logger = new Logger('Prueba');

  constructor(private readonly eventos: EventEmitter2) {}

  @Patch(':id')
  async tocar(
    @Param('id') id: string,
    @Body() cuerpo: { demoraMs: number; empresa: string },
  ): Promise<{ ok: true }> {
    await new Promise((r) => setTimeout(r, cuerpo.demoraMs));
    this.logger.log(`tocando ${id} de ${cuerpo.empresa}`);
    await conDisparo(RunTrigger.WEBHOOK, () =>
      recorder.ejecutar(ProcessName.PAYMENT_INBOX_PROCESS, null, async () => {
        await new Promise((r) => setTimeout(r, cuerpo.demoraMs / 2));
        this.logger.log(`corrida de ${cuerpo.empresa}`);
        pedirAvisoAlAdmin(this.eventos, this.logger, {
          distributorId: cuerpo.empresa,
          kind: 'prueba',
          title: 't',
          body: 'b',
          link: null,
          dedupeKey: id,
        });
        return 1;
      }),
    );
    return { ok: true };
  }
}

/**
 * Monitor O1, «otra distribuidora»: dos requests concurrentes con ids
 * distintos (el de A tarda más y termina después del de B). Cada traza ve
 * sólo lo suyo — el asiento, la corrida que disparó y el aviso — y las líneas
 * del log llevan el prefijo de su traza. Es la prueba del `AsyncLocalStorage`
 * de punta a punta: middleware, body parser, guardas, interceptor, corrida y
 * evento asincrónico.
 */
describe('Traza de punta a punta con requests concurrentes', () => {
  let app: INestApplication<Server>;
  let lineas: string[];
  let escribir: jest.SpyInstance;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      controllers: [PruebaController],
      providers: [BandejaDePrueba],
    }).compile();
    app = modulo.createNestApplication<INestApplication<Server>>({
      logger: new LoggerConTraza({ colors: false }),
    });
    app.use(requestIdMiddleware);
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.distributorId = (req.headers['x-distributor'] as string) ?? null;
      next();
    });
    const audit = {
      registrar: (a: NuevoAsiento) => {
        asientos.push({
          ...a,
          auditId: `a-${asientos.length + 1}`,
          createdAt: new Date(),
        } as AuditLog);
        return Promise.resolve();
      },
    } as unknown as AuditService;
    app.useGlobalInterceptors(new AuditInterceptor(audit, new Reflector()));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lineas = [];
    escribir = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((texto: string | Uint8Array) => {
        lineas.push(String(texto));
        return true;
      });
  });

  afterEach(() => escribir.mockRestore());

  it('cada traza ve sólo su asiento, su corrida y su aviso, y el log lleva su prefijo', async () => {
    const pedir = (traza: string, empresa: string, demoraMs: number) =>
      request(app.getHttpServer())
        .patch(`/prueba/${traza}`)
        .set('X-Request-Id', traza)
        .set('X-Distributor', empresa)
        .send({ demoraMs, empresa });
    const [a, b] = await Promise.all([
      pedir('traza-a', 'A', 60),
      pedir('traza-b', 'B', 5),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers['x-request-id']).toBe('traza-a');
    await new Promise((r) => setTimeout(r, 30)); // el aviso es asincrónico

    const service = trazasEnMemoria({ asientos, corridas, avisos });
    for (const [traza, propia, ajena] of [
      ['traza-a', 'A', 'B'],
      ['traza-b', 'B', 'A'],
    ] as const) {
      const r = await service.traza(traza);
      expect(r.items.map((i) => i.kind).sort()).toEqual(
        [
          TraceItemKind.AUDIT,
          TraceItemKind.NOTIFICATION,
          TraceItemKind.PROCESS_RUN,
        ].sort(),
      );
      const conEmpresa = r.items.filter((i) => i.distributorId !== null);
      expect(conEmpresa.every((i) => i.distributorId === propia)).toBe(true);
      expect(JSON.stringify(r)).not.toContain(`"distributorId":"${ajena}"`);
    }
    const corridaA = corridas.find((c) => c.traceId === 'traza-a');
    expect(corridaA).toMatchObject({
      trigger: RunTrigger.WEBHOOK,
      status: ProcessRunStatus.OK,
    });

    const log = lineas.join('');
    expect(log).toMatch(/\[t:traza-a\] tocando traza-a de A/);
    expect(log).toMatch(/\[t:traza-a\] corrida de A/);
    expect(log).toMatch(/\[t:traza-b\] corrida de B/);
    expect(log).not.toMatch(/\[t:traza-a\] corrida de B/);
    expect(log).not.toMatch(/\[t:traza-b\] corrida de A/);
  });

  it('un X-Request-Id inválido se reemplaza por uno nuevo, que es la traza', async () => {
    const r = await request(app.getHttpServer())
      .patch('/prueba/x')
      .set('X-Request-Id', 'con espacios y ; raros')
      .set('X-Distributor', 'A')
      .send({ demoraMs: 1, empresa: 'A' })
      .expect(200);
    const id = String(r.headers['x-request-id']);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const traza = await trazasEnMemoria({ asientos, corridas, avisos }).traza(
      id,
    );
    expect(traza.items.length).toBeGreaterThan(0);
  });
});
