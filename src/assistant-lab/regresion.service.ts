import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { codigoSqlDelError } from '../common/errors/db-exceptions';
import { errorMessage } from '../common/errors/error-message';
import {
  casoNormalizado,
  corridaPerdida,
  type Esperado,
  evaluarCaso,
  LARGO_DE_LA_MENCION,
  LARGO_DEL_CASO,
  MINUTOS_ENTRE_CORRIDAS,
  type ResultadoDeCasoGuardado,
  SEGUNDOS_SIN_LATIDO,
  TOPE_DE_CASOS,
  TOPE_DE_MENCIONES,
} from './assistant-lab.dominio';
import {
  casoInexistente,
  casoInvalido,
  casoRepetido,
  corridaEnCurso,
  corridaReciente,
  esTopeDePruebas,
  sinCasos,
  sinCorridas,
  topeDeCasos,
} from './assistant-lab.errors';
import { AssistantRegressionCase } from './entities/assistant-regression-case.entity';
import { AssistantRegressionRun } from './entities/assistant-regression-run.entity';
import { ProbadorService } from './probador.service';

const UNICO_VIOLADO = '23505';

export interface DatosDelCaso {
  question: string;
  expected: Esperado;
  mustMention?: string[];
}

export type CambiosDelCaso = Partial<DatosDelCaso>;

/** Las menciones sin espacios de los bordes, sin vacías ni repetidas (sin distinguir mayúsculas). */
function limpiarMenciones(menciones: readonly string[]): string[] {
  const vistas = new Set<string>();
  const limpias: string[] = [];
  for (const m of menciones) {
    const texto = m.trim();
    const clave = texto.toLowerCase();
    if (texto.length === 0 || vistas.has(clave)) continue;
    vistas.add(clave);
    limpias.push(texto);
  }
  return limpias;
}

/**
 * La segunda capa del caso (la primera es el DTO; la tercera, los CHECK):
 * largo de la pregunta, tope de menciones y que una derivación esperada no
 * pida menciones.
 */
function assertCasoValido(caso: Required<DatosDelCaso>): void {
  const largo = [...caso.question.trim()].length;
  if (largo < LARGO_DEL_CASO.min || largo > LARGO_DEL_CASO.max) {
    throw casoInvalido(
      `La pregunta tiene que tener entre ${LARGO_DEL_CASO.min} y ${LARGO_DEL_CASO.max} caracteres`,
    );
  }
  if (caso.mustMention.length > TOPE_DE_MENCIONES) {
    throw casoInvalido(
      `Se pueden pedir hasta ${TOPE_DE_MENCIONES} menciones por caso`,
    );
  }
  if (caso.mustMention.some((m) => [...m].length > LARGO_DE_LA_MENCION.max)) {
    throw casoInvalido(
      `Cada mención puede tener hasta ${LARGO_DE_LA_MENCION.max} caracteres`,
    );
  }
  if (caso.expected === 'handoff' && caso.mustMention.length > 0) {
    throw casoInvalido(
      'Si se espera que pase a una persona, no hay respuesta que tenga que mencionar algo',
    );
  }
}

/**
 * Lote de regresión del asistente de una empresa (DISENO-CH-BOT §7, 7b): sus
 * casos (alta, edición y baja lógica, hasta 100) y la corrida de todos con el
 * probador.
 *
 * La corrida es asíncrona: hasta 100 casos de hasta 4 consultas de 8 s no
 * entran en una request. El alta deja la corrida «en curso» (una por empresa,
 * con el único parcial de la base) y responde 202; los casos se corren uno
 * tras otro en el mismo proceso (no hay cola de trabajos en el back) y el
 * resultado de cada uno se guarda al terminarlo con un latido (`updated_at`),
 * así el panel puede mostrar el avance. Si el proceso se reinicia en el
 * medio, la corrida se queda sin latido: a los 2 minutos se informa fallida
 * y la siguiente la marca así. Una corrida cada 10 minutos por empresa.
 *
 * Toda escritura de casos corre con un cerrojo de transacción por empresa
 * (`pg_advisory_xact_lock`): el tope y las repetidas se controlan sin
 * carreras. Todo filtrado por la empresa del contexto: lo de otra es 404.
 */
@Injectable()
export class RegresionService {
  private readonly logger = new Logger(RegresionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly probador: ProbadorService,
  ) {}

  listar(distributorId: string): Promise<AssistantRegressionCase[]> {
    return this.dataSource.getRepository(AssistantRegressionCase).find({
      where: { distributorId },
      order: { createdAt: 'ASC', caseId: 'ASC' },
    });
  }

  async crear(
    distributorId: string,
    datos: DatosDelCaso,
    actorUserId: string | null,
  ): Promise<AssistantRegressionCase> {
    const caso = {
      question: datos.question.trim(),
      expected: datos.expected,
      mustMention: limpiarMenciones(datos.mustMention ?? []),
    };
    assertCasoValido(caso);
    return this.escribir(distributorId, async (manager) => {
      const vigentes = await this.vigentes(manager, distributorId);
      if (vigentes.length >= TOPE_DE_CASOS) throw topeDeCasos();
      if (this.repetido(vigentes, caso.question)) throw casoRepetido();
      const repo = manager.getRepository(AssistantRegressionCase);
      return repo.save(
        repo.create({
          distributorId,
          ...caso,
          createdBy: actorUserId,
          updatedBy: actorUserId,
        }),
      );
    });
  }

  async actualizar(
    distributorId: string,
    caseId: string,
    cambios: CambiosDelCaso,
    actorUserId: string | null,
  ): Promise<AssistantRegressionCase> {
    return this.escribir(distributorId, async (manager) => {
      const fila = await this.buscar(manager, distributorId, caseId);
      const expected = cambios.expected ?? fila.expected;
      const caso = {
        question: (cambios.question ?? fila.question).trim(),
        expected,
        // Pasar a «derivar» sin mandar menciones las deja vacías (no aplican).
        mustMention: limpiarMenciones(
          cambios.mustMention ??
            (expected === 'handoff' ? [] : fila.mustMention),
        ),
      };
      assertCasoValido(caso);
      if (casoNormalizado(caso.question) !== casoNormalizado(fila.question)) {
        const vigentes = await this.vigentes(manager, distributorId);
        const otros = vigentes.filter((v) => v.caseId !== fila.caseId);
        if (this.repetido(otros, caso.question)) throw casoRepetido();
      }
      Object.assign(fila, caso, { updatedBy: actorUserId });
      return manager.getRepository(AssistantRegressionCase).save(fila);
    });
  }

  /** Baja lógica: deja de correrse; la fila y su historia quedan. */
  async darDeBaja(
    distributorId: string,
    caseId: string,
    actorUserId: string | null,
  ): Promise<void> {
    await this.escribir(distributorId, async (manager) => {
      const fila = await this.buscar(manager, distributorId, caseId);
      fila.updatedBy = actorUserId;
      await manager.getRepository(AssistantRegressionCase).save(fila);
      await manager.getRepository(AssistantRegressionCase).softRemove(fila);
    });
  }

  /**
   * La última corrida de la empresa; 404 si nunca corrió. Una «en curso» sin
   * latido se informa fallida (terminó con su último latido): no se escribe
   * acá, así también se puede leer en modo soporte; la marca la siguiente.
   */
  async ultima(
    distributorId: string,
    ahora: Date = new Date(),
  ): Promise<AssistantRegressionRun> {
    const corrida = await this.dataSource
      .getRepository(AssistantRegressionRun)
      .findOne({
        where: { distributorId },
        order: { startedAt: 'DESC', runId: 'DESC' },
      });
    if (!corrida) throw sinCorridas();
    return corridaPerdida(corrida, ahora)
      ? Object.assign(new AssistantRegressionRun(), corrida, {
          status: 'failed',
          finishedAt: corrida.updatedAt,
        })
      : corrida;
  }

  /**
   * Arranca la corrida de todos los casos vigentes y la devuelve «en curso»
   * sin esperarla. 409 si ya hay una en curso con latido o si no hay casos;
   * 429 si la última empezó hace menos de 10 minutos. Una en curso sin
   * latido se marca fallida.
   */
  async iniciar(
    distributorId: string,
    actorUserId: string | null,
    ahora: Date = new Date(),
  ): Promise<AssistantRegressionRun> {
    const { corrida, casos } = await this.escribir(
      distributorId,
      async (manager) => {
        const repo = manager.getRepository(AssistantRegressionRun);
        const enCurso = await repo.findOne({
          where: { distributorId, status: 'running' },
        });
        if (enCurso) {
          if (!corridaPerdida(enCurso, ahora)) throw corridaEnCurso();
          enCurso.status = 'failed';
          enCurso.finishedAt = enCurso.updatedAt;
          await repo.save(enCurso);
          this.logger.warn(
            `Lote de regresión ${enCurso.runId}: sin latido hace más de ${SEGUNDOS_SIN_LATIDO} s, se da por perdido`,
          );
        }
        const ultima = await repo.findOne({
          where: { distributorId },
          order: { startedAt: 'DESC', runId: 'DESC' },
        });
        if (ultima) {
          const faltan =
            MINUTOS_ENTRE_CORRIDAS * 60_000 -
            (ahora.getTime() - ultima.startedAt.getTime());
          if (faltan > 0) throw corridaReciente(Math.ceil(faltan / 60_000));
        }
        const vigentes = await this.vigentes(manager, distributorId);
        if (vigentes.length === 0) throw sinCasos();
        const nueva = await repo.save(
          repo.create({
            distributorId,
            status: 'running',
            total: vigentes.length,
            passed: 0,
            failed: 0,
            errored: 0,
            results: [],
            startedBy: actorUserId,
            startedAt: ahora,
            updatedAt: ahora,
            finishedAt: null,
          }),
        );
        return { corrida: nueva, casos: vigentes };
      },
    );
    void this.correr(corrida, casos, actorUserId);
    return corrida;
  }

  /**
   * Corre los casos uno tras otro con el probador y guarda cada resultado con
   * su latido. Un caso que falla queda `error` y la corrida sigue (el cupo de
   * pruebas agotado, con su motivo). Nunca tira: si no se puede guardar, la
   * corrida queda fallida. Si otra la dio por perdida, deja de guardar.
   */
  async correr(
    corrida: AssistantRegressionRun,
    casos: readonly AssistantRegressionCase[],
    actorUserId: string | null,
  ): Promise<void> {
    const resultados: ResultadoDeCasoGuardado[] = [];
    const cuenta = { passed: 0, failed: 0, errored: 0 };
    try {
      for (const caso of casos) {
        const resultado = await this.probarCaso(
          corrida.distributorId,
          caso,
          actorUserId,
        );
        if (resultado.outcome === 'passed') cuenta.passed += 1;
        else if (resultado.outcome === 'failed') cuenta.failed += 1;
        else cuenta.errored += 1;
        resultados.push(resultado);
        const sigue = await this.guardarAvance(corrida, resultados, cuenta);
        if (!sigue) return;
      }
      await this.dataSource.query(
        `UPDATE "assistant_regression_run"
            SET "status" = 'finished', "finished_at" = now(), "updated_at" = now()
          WHERE "run_id" = $1 AND "distributor_id" = $2 AND "status" = 'running'`,
        [corrida.runId, corrida.distributorId],
      );
    } catch (error) {
      this.logger.error(
        `Lote de regresión ${corrida.runId}: falló (${errorMessage(error)})`,
      );
      await this.dataSource
        .query(
          `UPDATE "assistant_regression_run"
              SET "status" = 'failed', "finished_at" = now(), "updated_at" = now()
            WHERE "run_id" = $1 AND "distributor_id" = $2 AND "status" = 'running'`,
          [corrida.runId, corrida.distributorId],
        )
        .catch((e: unknown) =>
          this.logger.error(
            `Lote de regresión ${corrida.runId}: no se pudo marcar fallida (${errorMessage(e)})`,
          ),
        );
    }
  }

  /** Un caso con el probador; si falla, queda `error` con su motivo (nunca tira). */
  private async probarCaso(
    distributorId: string,
    caso: AssistantRegressionCase,
    actorUserId: string | null,
  ): Promise<ResultadoDeCasoGuardado> {
    const foto = {
      caseId: caso.caseId,
      question: caso.question,
      expected: caso.expected,
      mustMention: caso.mustMention,
    };
    try {
      const vista = await this.probador.deLaEmpresa({
        distributorId,
        question: caso.question,
        actorUserId,
        tipo: 'regression',
      });
      return {
        ...foto,
        answer: vista.answer,
        wouldHandOff: vista.wouldHandOff,
        handOffReason: vista.handOffReason,
        handOffReasonLabel: vista.handOffReasonLabel,
        handOffCause: vista.handOffCause,
        handOffCauseLabel: vista.handOffCauseLabel,
        sources: vista.sources,
        layer: vista.layer,
        ...evaluarCaso(caso, vista),
      };
    } catch (error) {
      const cupo = esTopeDePruebas(error);
      if (!cupo) {
        this.logger.error(
          `Lote de regresión: falló el caso ${caso.caseId} (${errorMessage(error)})`,
        );
      }
      return {
        ...foto,
        answer: null,
        wouldHandOff: false,
        handOffReason: null,
        handOffReasonLabel: null,
        handOffCause: null,
        handOffCauseLabel: null,
        sources: [],
        layer: 'fixed',
        outcome: 'error',
        reason: cupo ? 'test_quota_reached' : 'case_error',
        detail: cupo
          ? 'No se pudo probar: se terminó el cupo de pruebas del asistente de este mes'
          : 'No se pudo probar este caso por un error interno',
        missing: [],
      };
    }
  }

  /** Guarda lo corrido hasta ahora y el latido; `false` si la corrida ya no está en curso. */
  private async guardarAvance(
    corrida: AssistantRegressionRun,
    resultados: ResultadoDeCasoGuardado[],
    cuenta: { passed: number; failed: number; errored: number },
  ): Promise<boolean> {
    const [fila]: Array<{ n: number }> = await this.dataSource.query(
      `WITH guardada AS (
         UPDATE "assistant_regression_run"
            SET "results" = $3::jsonb, "passed" = $4, "failed" = $5, "errored" = $6,
                "updated_at" = now()
          WHERE "run_id" = $1 AND "distributor_id" = $2 AND "status" = 'running'
          RETURNING "run_id")
       SELECT count(*)::int AS n FROM guardada`,
      [
        corrida.runId,
        corrida.distributorId,
        JSON.stringify(resultados),
        cuenta.passed,
        cuenta.failed,
        cuenta.errored,
      ],
    );
    return (fila?.n ?? 0) > 0;
  }

  /** Corre la escritura con el cerrojo de la empresa; el único de la base vuelve como 409. */
  private async escribir<T>(
    distributorId: string,
    trabajo: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `assistant_regression:${distributorId}`,
        ]);
        return trabajo(manager);
      });
    } catch (error) {
      if (codigoSqlDelError(error) === UNICO_VIOLADO) {
        throw restriccion(error) === 'UQ_assistant_regression_run_en_curso'
          ? corridaEnCurso()
          : casoRepetido();
      }
      throw error;
    }
  }

  private vigentes(
    manager: EntityManager,
    distributorId: string,
  ): Promise<AssistantRegressionCase[]> {
    return manager.getRepository(AssistantRegressionCase).find({
      where: { distributorId },
      order: { createdAt: 'ASC', caseId: 'ASC' },
    });
  }

  private repetido(
    vigentes: ReadonlyArray<Pick<AssistantRegressionCase, 'question'>>,
    question: string,
  ): boolean {
    const buscada = casoNormalizado(question);
    return vigentes.some((v) => casoNormalizado(v.question) === buscada);
  }

  /** El vigente de esta empresa; lo de otra (o dado de baja) es 404. */
  private async buscar(
    manager: EntityManager,
    distributorId: string,
    caseId: string,
  ): Promise<AssistantRegressionCase> {
    const fila = await manager
      .getRepository(AssistantRegressionCase)
      .findOne({ where: { caseId, distributorId } });
    if (!fila) throw casoInexistente();
    return fila;
  }
}

/** Nombre de la restricción de un error de Postgres (directo o envuelto por TypeORM). */
function restriccion(error: unknown): string | undefined {
  const e = error as {
    constraint?: unknown;
    driverError?: { constraint?: unknown };
  };
  const nombre = e.constraint ?? e.driverError?.constraint;
  return typeof nombre === 'string' ? nombre : undefined;
}
