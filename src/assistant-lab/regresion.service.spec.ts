import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { MotivoDeDerivacion } from '../assistant-ai/asistente-ia.dominio';
import type { VistaPrevia } from './assistant-lab.dominio';
import { AssistantRegressionCase } from './entities/assistant-regression-case.entity';
import { AssistantRegressionRun } from './entities/assistant-regression-run.entity';
import { topeDePruebas } from './assistant-lab.errors';
import type { PreguntaDeLaEmpresa, ProbadorService } from './probador.service';
import { RegresionService } from './regresion.service';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const AHORA = new Date('2026-11-16T15:00:00Z');

const RESPONDE: VistaPrevia = {
  answer: 'Abrimos de lunes a sábado de 8 a 20.',
  wouldHandOff: false,
  handOffReason: null,
  handOffReasonLabel: null,
  handOffCause: null,
  handOffCauseLabel: null,
  sources: [{ type: 'faq', id: 'faq-1', title: '¿Horario?' }],
  layer: 'ai',
  assistantEnabled: true,
};
const DERIVA: VistaPrevia = {
  answer: null,
  wouldHandOff: true,
  handOffReason: MotivoDeDerivacion.REQUESTED,
  handOffReasonLabel: 'El asistente no pudo resolverlo',
  handOffCause: null,
  handOffCauseLabel: null,
  sources: [],
  layer: 'ai',
  assistantEnabled: true,
};
const TOPE: VistaPrevia = {
  ...DERIVA,
  handOffReason: MotivoDeDerivacion.MONTHLY_LIMIT,
  handOffReasonLabel: 'Se llegó al tope mensual del asistente',
  layer: 'fixed',
};

type Clase = typeof AssistantRegressionCase | typeof AssistantRegressionRun;

/**
 * Casos y corridas en memoria. El cerrojo por empresa se anota (y se exige
 * antes de leer), los `find` filtran por la empresa del `where` como la base
 * y las bajas lógicas no salen.
 */
function armar(respuestas: Array<VistaPrevia | Error> = []) {
  const casos: AssistantRegressionCase[] = [];
  const corridas: AssistantRegressionRun[] = [];
  const cerrojos: string[] = [];
  let secuencia = 0;
  let reloj = AHORA.getTime();

  const filtrar = <T extends object>(
    filas: T[],
    where: Record<string, unknown>,
  ): T[] =>
    filas.filter(
      (f) =>
        (f as { deletedAt?: Date | null }).deletedAt == null &&
        Object.entries(where).every(
          ([k, v]) => (f as Record<string, unknown>)[k] === v,
        ),
    );

  const repoDe = (clase: Clase) => {
    const filas = clase === AssistantRegressionCase ? casos : corridas;
    return {
      find: jest.fn((o: { where: Record<string, unknown> }) =>
        Promise.resolve(filtrar(filas as object[], o.where)),
      ),
      findOne: jest.fn(
        (o: {
          where: Record<string, unknown>;
          order?: Record<string, string>;
        }) => {
          const encontradas = filtrar(filas as object[], o.where);
          if (o.order) {
            encontradas.sort(
              (x, y) =>
                (y as AssistantRegressionRun).startedAt.getTime() -
                (x as AssistantRegressionRun).startedAt.getTime(),
            );
          }
          return Promise.resolve(encontradas[0] ?? null);
        },
      ),
      create: jest.fn((d: object) =>
        Object.assign(
          clase === AssistantRegressionCase
            ? new AssistantRegressionCase()
            : new AssistantRegressionRun(),
          d,
        ),
      ),
      save: jest.fn(
        (fila: AssistantRegressionCase | AssistantRegressionRun) => {
          reloj += 1000;
          if (fila instanceof AssistantRegressionCase) {
            if (!fila.caseId) {
              secuencia += 1;
              Object.assign(fila, {
                caseId: `caso-${secuencia}`,
                createdAt: new Date(reloj),
                deletedAt: null,
              });
              casos.push(fila);
            }
            fila.updatedAt = new Date(reloj);
          } else if (!fila.runId) {
            secuencia += 1;
            fila.runId = `corrida-${secuencia}`;
            corridas.push(fila);
          }
          return Promise.resolve(fila);
        },
      ),
      softRemove: jest.fn((fila: AssistantRegressionCase) => {
        fila.deletedAt = new Date(reloj);
        return Promise.resolve(fila);
      }),
    };
  };
  const repos = new Map<Clase, ReturnType<typeof repoDe>>([
    [AssistantRegressionCase, repoDe(AssistantRegressionCase)],
    [AssistantRegressionRun, repoDe(AssistantRegressionRun)],
  ]);
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        cerrojos.push(params[0] as string);
      }
      return Promise.resolve([]);
    }),
    getRepository: (c: Clase) => {
      if (cerrojos.length === 0) throw new Error('sin cerrojo');
      return repos.get(c)!;
    },
  };
  let fallaAlGuardar: Error | null = null;
  /** El `now()` de la base al guardar un avance (el latido). */
  let latido = AHORA;
  const actualizaciones: string[] = [];
  const dataSource = {
    transaction: jest.fn(
      async (trabajo: (m: typeof manager) => Promise<unknown>) => {
        try {
          return await trabajo(manager);
        } finally {
          cerrojos.length = 0;
        }
      },
    ),
    getRepository: (c: Clase) => repos.get(c)!,
    query: jest.fn((sql: string, params: unknown[]) => {
      const i = corridas.findIndex(
        (r) => r.runId === params[0] && r.distributorId === params[1],
      );
      const enCurso = corridas[i]?.status === 'running';
      // Como la base: la fila cambia, no el objeto que tiene quien la leyó antes.
      const cambiar = (cambios: Partial<AssistantRegressionRun>) => {
        corridas[i] = Object.assign(
          new AssistantRegressionRun(),
          corridas[i],
          cambios,
        );
      };
      if (sql.includes('"results" = $3')) {
        actualizaciones.push('avance');
        if (fallaAlGuardar) return Promise.reject(fallaAlGuardar);
        if (enCurso) {
          cambiar({
            results: JSON.parse(
              params[2] as string,
            ) as AssistantRegressionRun['results'],
            passed: params[3] as number,
            failed: params[4] as number,
            errored: params[5] as number,
            updatedAt: latido,
          });
        }
        return Promise.resolve([{ n: enCurso ? 1 : 0 }]);
      }
      const estado = sql.includes("'finished'") ? 'finished' : 'failed';
      actualizaciones.push(estado);
      if (enCurso) cambiar({ status: estado, finishedAt: new Date(reloj) });
      return Promise.resolve([]);
    }),
  };
  const pendientes = [...respuestas];
  const probador = {
    deLaEmpresa: jest.fn((p: PreguntaDeLaEmpresa) => {
      void p;
      const r = pendientes.shift() ?? RESPONDE;
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }),
  };
  const servicio = new RegresionService(
    dataSource as unknown as DataSource,
    probador as unknown as ProbadorService,
  );
  return {
    servicio,
    casos,
    corridas,
    probador,
    manager,
    dataSource,
    actualizaciones,
    fallarAlGuardar: (e: Error) => {
      fallaAlGuardar = e;
    },
    latirA: (d: Date) => {
      latido = d;
    },
  };
}

const cuerpo = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; response: { code?: string } };
  }
  throw new Error('no lanzó');
};

describe('RegresionService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('casos', () => {
    it('alta con el cerrojo de la empresa, la pregunta recortada y las menciones limpias (sin vacías ni repetidas)', async () => {
      const t = armar();
      const caso = await t.servicio.crear(
        A,
        {
          question: '  ¿Hasta qué hora abren?  ',
          expected: 'answer',
          mustMention: [' 20 ', '20', '', 'Sábado', 'sábado'],
        },
        'admin-a',
      );
      expect(caso).toMatchObject({
        distributorId: A,
        question: '¿Hasta qué hora abren?',
        expected: 'answer',
        mustMention: ['20', 'Sábado'],
        createdBy: 'admin-a',
      });
      expect(t.manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`assistant_regression:${A}`],
      );
    });

    it('sin menciones queda la lista vacía', async () => {
      const t = armar();
      const caso = await t.servicio.crear(
        A,
        { question: '¿Me devuelven la plata?', expected: 'handoff' },
        'admin-a',
      );
      expect(caso.mustMention).toEqual([]);
    });

    it('409 si ya hay uno con la misma pregunta (sin mayúsculas) en la empresa; otra empresa puede tenerla', async () => {
      const t = armar();
      await t.servicio.crear(
        A,
        { question: '¿Abren?', expected: 'answer' },
        'a',
      );
      expect(
        await cuerpo(
          t.servicio.crear(
            A,
            { question: '¿ABREN?', expected: 'handoff' },
            'a',
          ),
        ),
      ).toMatchObject({
        status: 409,
        response: { code: 'ASSISTANT_REGRESSION_CASE_DUPLICATE' },
      });
      await expect(
        t.servicio.crear(B, { question: '¿Abren?', expected: 'answer' }, 'b'),
      ).resolves.toMatchObject({ distributorId: B });
    });

    it('409 al pasar el tope de 100 por empresa (los dados de baja no cuentan)', async () => {
      const t = armar();
      for (let i = 0; i < 100; i += 1) {
        await t.servicio.crear(
          A,
          { question: `Pregunta ${i}`, expected: 'answer' },
          'a',
        );
      }
      expect(
        await cuerpo(
          t.servicio.crear(A, { question: 'Una más', expected: 'answer' }, 'a'),
        ),
      ).toMatchObject({
        status: 409,
        response: { code: 'ASSISTANT_REGRESSION_CASE_LIMIT_REACHED' },
      });
      await t.servicio.darDeBaja(A, t.casos[0].caseId, 'a');
      await expect(
        t.servicio.crear(A, { question: 'Una más', expected: 'answer' }, 'a'),
      ).resolves.toBeDefined();
    });

    it.each([
      [{ question: 'x', expected: 'answer' as const }, /entre 2 y 500/],
      [
        { question: 'x'.repeat(501), expected: 'answer' as const },
        /entre 2 y 500/,
      ],
      [
        {
          question: '¿Abren?',
          expected: 'answer' as const,
          mustMention: Array.from({ length: 11 }, (_, i) => `m${i}`),
        },
        /hasta 10 menciones/,
      ],
      [
        {
          question: '¿Abren?',
          expected: 'answer' as const,
          mustMention: ['x'.repeat(101)],
        },
        /hasta 100 caracteres/,
      ],
      [
        {
          question: '¿Me devuelven?',
          expected: 'handoff' as const,
          mustMention: ['plata'],
        },
        /no hay respuesta que tenga que mencionar/,
      ],
    ])(
      '400 de la segunda capa (%#), sin tocar la base',
      async (datos, mensaje) => {
        const t = armar();
        const e = await cuerpo(t.servicio.crear(A, datos, 'a'));
        expect(e.status).toBe(400);
        expect(String((e.response as { message?: unknown }).message)).toMatch(
          mensaje,
        );
        expect(t.dataSource.transaction).not.toHaveBeenCalled();
      },
    );

    it('edición: lo que no viene queda; pasar a derivar sin menciones las vacía; lo de otra empresa es 404', async () => {
      const t = armar();
      const caso = await t.servicio.crear(
        A,
        { question: '¿Abren?', expected: 'answer', mustMention: ['20'] },
        'a',
      );
      const editado = await t.servicio.actualizar(
        A,
        caso.caseId,
        { mustMention: ['20', 'sábado'] },
        'a2',
      );
      expect(editado).toMatchObject({
        question: '¿Abren?',
        expected: 'answer',
        mustMention: ['20', 'sábado'],
        updatedBy: 'a2',
      });
      const aDerivar = await t.servicio.actualizar(
        A,
        caso.caseId,
        { expected: 'handoff' },
        'a2',
      );
      expect(aDerivar.mustMention).toEqual([]);
      expect(
        await cuerpo(
          t.servicio.actualizar(B, caso.caseId, { question: '¿Y?' }, 'b'),
        ),
      ).toMatchObject({
        status: 404,
        response: { code: 'ASSISTANT_REGRESSION_CASE_NOT_FOUND' },
      });
    });

    it('edición: cambiar la pregunta a la de otro caso es 409; a la misma (otras mayúsculas) no', async () => {
      const t = armar();
      await t.servicio.crear(
        A,
        { question: '¿Abren?', expected: 'answer' },
        'a',
      );
      const otro = await t.servicio.crear(
        A,
        { question: '¿Cierran?', expected: 'answer' },
        'a',
      );
      expect(
        await cuerpo(
          t.servicio.actualizar(A, otro.caseId, { question: '¿abren?' }, 'a'),
        ),
      ).toMatchObject({ status: 409 });
      await expect(
        t.servicio.actualizar(A, otro.caseId, { question: '¿CIERRAN?' }, 'a'),
      ).resolves.toMatchObject({ question: '¿CIERRAN?' });
      await expect(
        t.servicio.actualizar(A, otro.caseId, { question: '¿Llegan?' }, 'a'),
      ).resolves.toMatchObject({ question: '¿Llegan?' });
    });

    it('baja lógica: deja de listarse y queda quién la dio; dos veces o de otra empresa es 404', async () => {
      const t = armar();
      const caso = await t.servicio.crear(
        A,
        { question: '¿Abren?', expected: 'answer' },
        'a',
      );
      await t.servicio.darDeBaja(A, caso.caseId, 'a2');
      expect(t.casos[0]).toMatchObject({ updatedBy: 'a2' });
      expect(t.casos[0].deletedAt).toBeInstanceOf(Date);
      expect(await t.servicio.listar(A)).toEqual([]);
      expect(
        await cuerpo(t.servicio.darDeBaja(A, caso.caseId, 'a')),
      ).toMatchObject({ status: 404 });
    });

    it('aislamiento: cada empresa lista sólo sus casos', async () => {
      const t = armar();
      await t.servicio.crear(
        A,
        { question: '¿De A?', expected: 'answer' },
        'a',
      );
      await t.servicio.crear(
        B,
        { question: '¿De B?', expected: 'answer' },
        'b',
      );
      expect((await t.servicio.listar(A)).map((c) => c.question)).toEqual([
        '¿De A?',
      ]);
    });

    it('el único de la base (carrera) vuelve como 409 del caso; otro error sale tal cual', async () => {
      const t = armar();
      t.dataSource.transaction.mockRejectedValueOnce(
        Object.assign(new Error('dup'), {
          code: '23505',
          constraint: 'UQ_assistant_regression_case_pregunta_vigente',
        }),
      );
      expect(
        await cuerpo(
          t.servicio.crear(A, { question: '¿Abren?', expected: 'answer' }, 'a'),
        ),
      ).toMatchObject({
        status: 409,
        response: { code: 'ASSISTANT_REGRESSION_CASE_DUPLICATE' },
      });
      t.dataSource.transaction.mockRejectedValueOnce(new Error('se cayó'));
      await expect(
        t.servicio.crear(A, { question: '¿Abren?', expected: 'answer' }, 'a'),
      ).rejects.toThrow('se cayó');
    });
  });

  describe('corrida', () => {
    const conCasos = async (t: ReturnType<typeof armar>, empresa = A) => {
      await t.servicio.crear(
        empresa,
        {
          question: '¿Hasta qué hora abren?',
          expected: 'answer',
          mustMention: ['20'],
        },
        'a',
      );
      await t.servicio.crear(
        empresa,
        { question: '¿Me devuelven la plata?', expected: 'handoff' },
        'a',
      );
      await t.servicio.crear(
        empresa,
        {
          question: '¿Aceptan cheques?',
          expected: 'answer',
          mustMention: ['cheque'],
        },
        'a',
      );
    };
    const minutos = (n: number) => new Date(AHORA.getTime() + n * 60_000);

    /** Espera a que termine la corrida que quedó andando sola. */
    const terminar = async (t: ReturnType<typeof armar>) => {
      for (
        let i = 0;
        i < 50 && t.corridas.some((c) => c.status === 'running');
        i += 1
      ) {
        await new Promise((r) => setImmediate(r));
      }
    };

    it('arranca «en curso» sin esperar y corre cada caso con el probador (como regresión, sin cliente); guarda cada resultado con su latido y el resumen', async () => {
      const t = armar([RESPONDE, DERIVA, RESPONDE]);
      await conCasos(t);
      t.latirA(minutos(1));
      const corrida = await t.servicio.iniciar(A, 'admin-a', AHORA);
      expect(corrida).toMatchObject({
        distributorId: A,
        status: 'running',
        total: 3,
        passed: 0,
        results: [],
        startedBy: 'admin-a',
        startedAt: AHORA,
        updatedAt: AHORA,
      });
      await terminar(t);
      expect(t.probador.deLaEmpresa.mock.calls.map(([p]) => p)).toEqual([
        {
          distributorId: A,
          question: '¿Hasta qué hora abren?',
          actorUserId: 'admin-a',
          tipo: 'regression',
        },
        expect.objectContaining({ question: '¿Me devuelven la plata?' }),
        expect.objectContaining({ question: '¿Aceptan cheques?' }),
      ]);
      const final = t.corridas[0];
      expect(final).toMatchObject({
        status: 'finished',
        passed: 2,
        failed: 1,
        errored: 0,
        updatedAt: minutos(1),
      });
      expect(final.finishedAt).toBeInstanceOf(Date);
      expect(final.results).toEqual([
        expect.objectContaining({
          caseId: 'caso-1',
          question: '¿Hasta qué hora abren?',
          expected: 'answer',
          mustMention: ['20'],
          answer: RESPONDE.answer,
          sources: RESPONDE.sources,
          layer: 'ai',
          outcome: 'passed',
        }),
        expect.objectContaining({ outcome: 'passed', wouldHandOff: true }),
        expect.objectContaining({
          outcome: 'failed',
          reason: 'missing_mentions',
          missing: ['cheque'],
        }),
      ]);
      expect(final.results[0]).not.toHaveProperty('assistantEnabled');
      expect(t.actualizaciones).toEqual([
        'avance',
        'avance',
        'avance',
        'finished',
      ]);
      const [sqlDelAvance] = t.dataSource.query.mock.calls[0];
      expect(sqlDelAvance).toContain('"updated_at" = now()');
    });

    it('si la IA no corre (tope), los casos quedan como error, no como fallados', async () => {
      const t = armar([TOPE, TOPE, TOPE]);
      await conCasos(t);
      await t.servicio.iniciar(A, 'admin-a', AHORA);
      await terminar(t);
      expect(t.corridas[0]).toMatchObject({
        status: 'finished',
        passed: 0,
        failed: 0,
        errored: 3,
      });
    });

    it('un caso que falla queda error (case_error) y la corrida sigue con los demás', async () => {
      const t = armar([new Error('se cayó la consulta'), DERIVA, RESPONDE]);
      await conCasos(t);
      await t.servicio.iniciar(A, 'a', AHORA);
      await terminar(t);
      expect(t.corridas[0]).toMatchObject({
        status: 'finished',
        passed: 1,
        failed: 1,
        errored: 1,
      });
      expect(t.corridas[0].results[0]).toMatchObject({
        outcome: 'error',
        reason: 'case_error',
        detail: 'No se pudo probar este caso por un error interno',
        answer: null,
        layer: 'fixed',
      });
      expect(t.probador.deLaEmpresa).toHaveBeenCalledTimes(3);
    });

    it('cupo de pruebas agotado: el caso queda error (test_quota_reached) con su motivo, sin cortar', async () => {
      const t = armar([topeDePruebas(), topeDePruebas(), RESPONDE]);
      await conCasos(t);
      await t.servicio.iniciar(A, 'a', AHORA);
      await terminar(t);
      expect(t.corridas[0]).toMatchObject({ status: 'finished', errored: 2 });
      expect(t.corridas[0].results[0]).toMatchObject({
        outcome: 'error',
        reason: 'test_quota_reached',
        detail:
          'No se pudo probar: se terminó el cupo de pruebas del asistente de este mes',
      });
    });

    it('409 si hay una en curso con latido; 409 sin casos', async () => {
      const t = armar();
      expect(await cuerpo(t.servicio.iniciar(A, 'a', AHORA))).toMatchObject({
        status: 409,
        response: { code: 'ASSISTANT_REGRESSION_NO_CASES' },
      });
      await conCasos(t);
      t.probador.deLaEmpresa.mockImplementation(
        () => new Promise<VistaPrevia>(() => undefined),
      );
      await t.servicio.iniciar(A, 'a', AHORA);
      expect(
        await cuerpo(t.servicio.iniciar(A, 'a', minutos(1))),
      ).toMatchObject({
        status: 409,
        response: { code: 'ASSISTANT_REGRESSION_RUN_IN_PROGRESS' },
      });
      // Otra empresa no se traba por la de A.
      await t.servicio.crear(
        B,
        { question: '¿De B?', expected: 'answer' },
        'b',
      );
      await expect(t.servicio.iniciar(B, 'b', AHORA)).resolves.toMatchObject({
        distributorId: B,
      });
    });

    it('429 si la última empezó hace menos de 10 minutos (aunque haya terminado), con los minutos que faltan', async () => {
      const t = armar();
      await conCasos(t);
      await t.servicio.iniciar(A, 'a', AHORA);
      await terminar(t);
      const e = await cuerpo(t.servicio.iniciar(A, 'a', minutos(7.5)));
      expect(e).toMatchObject({
        status: 429,
        response: { code: 'ASSISTANT_REGRESSION_RUN_COOLDOWN' },
      });
      expect(String((e.response as { message?: unknown }).message)).toMatch(
        /en 3 minutos$/,
      );
      const casi = await cuerpo(t.servicio.iniciar(A, 'a', minutos(9.5)));
      expect(String((casi.response as { message?: unknown }).message)).toMatch(
        /en 1 minuto$/,
      );
      await expect(
        t.servicio.iniciar(A, 'a', minutos(10)),
      ).resolves.toBeDefined();
    });

    it('sin latido por más de 2 minutos se da por perdida (fallida, con su último latido) y arranca otra; la vieja deja de guardar', async () => {
      const t = armar();
      await conCasos(t);
      let soltar: (v: VistaPrevia) => void = () => undefined;
      t.probador.deLaEmpresa.mockImplementationOnce(
        () =>
          new Promise<VistaPrevia>((r) => {
            soltar = r;
          }),
      );
      await t.servicio.iniciar(A, 'a', AHORA);
      // A los 2 minutos todavía tiene latido.
      expect(
        await cuerpo(t.servicio.iniciar(A, 'a', minutos(2))),
      ).toMatchObject({ status: 409 });
      const despues = minutos(11);
      const nueva = await t.servicio.iniciar(A, 'a', despues);
      expect(t.corridas[0]).toMatchObject({
        status: 'failed',
        finishedAt: AHORA,
      });
      expect(nueva.runId).not.toBe(t.corridas[0].runId);
      soltar(RESPONDE);
      await terminar(t);
      expect(t.corridas[0].results).toEqual([]);
      expect(t.corridas[1]).toMatchObject({ status: 'finished', passed: 1 });
      // La vieja probó uno, quiso guardarlo y paró (no siguió con los otros dos).
      expect(t.probador.deLaEmpresa).toHaveBeenCalledTimes(4);
    });

    it('el único de la base (otra corrida arrancó a la vez) vuelve como 409 en curso', async () => {
      const t = armar();
      t.dataSource.transaction.mockRejectedValueOnce({
        code: '23505',
        driverError: { constraint: 'UQ_assistant_regression_run_en_curso' },
      });
      expect(await cuerpo(t.servicio.iniciar(A, 'a', AHORA))).toMatchObject({
        status: 409,
        response: { code: 'ASSISTANT_REGRESSION_RUN_IN_PROGRESS' },
      });
    });

    it('si no puede guardar el avance, la corrida queda fallida (nunca tira)', async () => {
      const t = armar();
      await conCasos(t);
      t.fallarAlGuardar(new Error('sin base'));
      await t.servicio.iniciar(A, 'a', AHORA);
      await terminar(t);
      expect(t.corridas[0]).toMatchObject({ status: 'failed' });
      expect(t.actualizaciones).toEqual(['avance', 'failed']);
    });

    it('si tampoco puede marcarla fallida, lo deja en el log y no tira', async () => {
      const t = armar();
      await conCasos(t);
      t.dataSource.query.mockImplementation(() =>
        Promise.reject(new Error('sin base')),
      );
      const error = jest.spyOn(Logger.prototype, 'error');
      await t.servicio.iniciar(A, 'a', AHORA);
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('no se pudo marcar fallida'),
      );
    });

    it('última corrida: la más reciente de la empresa; 404 si nunca corrió o es de otra', async () => {
      const t = armar();
      expect(await cuerpo(t.servicio.ultima(A))).toMatchObject({
        status: 404,
        response: { code: 'ASSISTANT_REGRESSION_RUN_NOT_FOUND' },
      });
      await conCasos(t);
      await t.servicio.iniciar(A, 'a', AHORA);
      await terminar(t);
      await t.servicio.iniciar(A, 'a', minutos(11));
      await terminar(t);
      expect((await t.servicio.ultima(A, minutos(12))).runId).toBe(
        t.corridas[1].runId,
      );
      expect(await cuerpo(t.servicio.ultima(B))).toMatchObject({ status: 404 });
    });

    it('última corrida en curso sin latido: se informa fallida (con su último latido), sin escribir', async () => {
      const t = armar();
      await conCasos(t);
      t.probador.deLaEmpresa.mockImplementation(
        () => new Promise<VistaPrevia>(() => undefined),
      );
      await t.servicio.iniciar(A, 'a', AHORA);
      expect(await t.servicio.ultima(A, minutos(1))).toMatchObject({
        status: 'running',
        finishedAt: null,
      });
      const vencida = await t.servicio.ultima(A, minutos(3));
      expect(vencida).toMatchObject({ status: 'failed', finishedAt: AHORA });
      expect(t.corridas[0].status).toBe('running');
    });
  });

  it('sin momento explícito usa el reloj', async () => {
    const t = armar();
    expect(await cuerpo(t.servicio.iniciar(A, 'a'))).toMatchObject({
      status: 409,
    });
    expect(await cuerpo(t.servicio.ultima(A))).toMatchObject({ status: 404 });
  });
});
