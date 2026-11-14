import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  QueryRunner,
  TransactionStartEvent,
} from 'typeorm';
import { soloLecturaDeSoporte } from '../../common/errors/soporte';
import { auditContext } from './audit-context';

/** Lo que antecede a la sentencia y no la cambia: espacios, paréntesis y comentarios. */
const PREFIJO_IRRELEVANTE = /^(?:\s|\(|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

/**
 * Escrituras que TypeORM manda sin transacción: INSERT, UPDATE, DELETE, MERGE,
 * TRUNCATE, COPY y los WITH que terminan en una de ellas. `CALL` NO: un
 * procedimiento que controla la transacción (`COMMIT`) no puede correr dentro
 * de una, y el actor no sobreviviría a ese `COMMIT`.
 */
const ES_ESCRITURA =
  /^(?:(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b|WITH\b[\s\S]*?\b(?:INSERT|UPDATE|DELETE|MERGE)\b)/i;

export function esEscritura(sql: string): boolean {
  return ES_ESCRITURA.test(sql.replace(PREFIJO_IRRELEVANTE, ''));
}

/**
 * Le dice a la base quién hace el cambio, para que el trigger de auditoría
 * (`auditoria_trigger`) lo asiente. El actor sale de `auditContext` (el request
 * en curso) y viaja en variables locales de la transacción
 * (`set_config(..., true)`): mueren con el commit o el rollback, así que no se
 * filtran a otro request que reuse la conexión del pool.
 *
 *  - Con transacción (`save`, `manager.transaction`, un `QueryRunner` propio):
 *    las fija `afterTransactionStart`.
 *  - Sin transacción (`update()`, `insert()`, `delete()`, query builders, SQL
 *    crudo): el query runner envuelve la escritura en una transacción de una
 *    sentencia para poder fijarlas. Las lecturas no se tocan.
 *
 * Fuera de un request (crons, seeds, scripts) no hay contexto y no se fija
 * nada: el trigger asienta usuario nulo, o sea «sistema».
 *
 * Modo soporte (`contexto.soporte`): toda transacción arranca en sólo lectura
 * (`SET TRANSACTION READ ONLY`; una escritura adentro falla con 25006 y el
 * filtro la responde 403 `SUPPORT_READ_ONLY`) y una escritura suelta se
 * rechaza antes de mandarla. Es la segunda capa: frena un `GET` que escribe
 * de costado, que el `AlcanceGuard` deja pasar.
 */
@Injectable()
export class ActorEnLaBase implements EntitySubscriberInterface {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    dataSource.subscribers.push(this);
    this.envolverEscriturasSueltas();
  }

  async afterTransactionStart(event: TransactionStartEvent): Promise<void> {
    await fijarActor(event.queryRunner);
  }

  private envolverEscriturasSueltas(): void {
    const driver = this.dataSource.driver;
    const crear = driver.createQueryRunner.bind(driver);
    driver.createQueryRunner = (modo) => {
      const runner = crear(modo);
      const query: QueryRunner['query'] = runner.query.bind(runner);
      runner.query = (async (
        ...args: Parameters<QueryRunner['query']>
      ): Promise<unknown> => {
        const [sql] = args;
        const contexto = auditContext.getStore();
        if (runner.isTransactionActive || !esEscritura(sql) || !contexto) {
          return query(...args);
        }
        if (contexto.soporte) throw soloLecturaDeSoporte();
        try {
          await runner.startTransaction();
          const resultado: unknown = await query(...args);
          await runner.commitTransaction();
          return resultado;
        } catch (error) {
          if (runner.isTransactionActive) {
            await runner.rollbackTransaction().catch(() => undefined);
          }
          throw error;
        }
      }) as QueryRunner['query'];
      return runner;
    };
  }
}

async function fijarActor(runner: QueryRunner): Promise<void> {
  const contexto = auditContext.getStore();
  if (!contexto) return;
  if (contexto.soporte) await runner.query('SET TRANSACTION READ ONLY');
  await runner.query(
    `SELECT set_config('splg.user_id', $1, true),
            set_config('splg.ip', $2, true),
            set_config('splg.distributor_id', $3, true)`,
    [contexto.userId ?? '', contexto.ip ?? '', contexto.distributorId ?? ''],
  );
}
