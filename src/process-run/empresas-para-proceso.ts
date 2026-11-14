import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import { errorMessage } from '../common/errors/error-message';
import { diaArgentino } from '../common/utils/dias-argentina';
import { DistributorService } from '../distributor/distributor.service';
import { AccesoDeLaEmpresa } from '../platform/access/acceso-de-la-empresa.service';
import type { ModuloKey } from '../platform/modules/catalogo-de-modulos';
import { RedisService } from '../redis/redis.service';
import { CATALOGO, ProcessName } from './domain/process-catalog';
import { registrarErrorAtrapado } from './process-run.context';

export interface OpcionesDelRecorrido {
  proceso: ProcessName;
  /** Sólo las empresas que tienen este módulo habilitado; `null` = proceso del núcleo. */
  modulo: ModuloKey | null;
  /**
   * El proceso crea cosas nuevas (invitaciones, ofertas, propuestas): además
   * de las bloqueadas se saltean las restringidas (§6.3; el estado
   * `restricted` llega en P5).
   */
  crea?: boolean;
  /** Candidatas ya filtradas por el proceso (p. ej. con pedidos); omitido = todas las vigentes. */
  entre?: readonly string[];
  /** Cuántas empresas a la vez. */
  concurrencia?: number;
  /** Presupuesto de tiempo por empresa y tic, en ms: pasado, se sigue con la próxima. */
  presupuestoMs?: number;
}

export type EstadoPorEmpresa =
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'locked'
  | 'circuit_open';

export interface ResultadoPorEmpresa<T> {
  distributorId: string;
  estado: EstadoPorEmpresa;
  valor?: T;
}

export interface ResultadoDelRecorrido<T> {
  empresas: Array<ResultadoPorEmpresa<T>>;
  /** Empresas que no corrieron por módulo deshabilitado o estado (no es falla). */
  salteadas: number;
}

/** Lo que se guarda del cortacircuito de una empresa en un proceso. */
interface Circuito {
  fallas: number;
  /** Hasta cuándo (epoch ms) se saltea la empresa. */
  hasta: number;
}

/** Lo que el proceso puede preguntar mientras trabaja una empresa. */
export interface EmpresaEnCurso {
  /**
   * Vuelve a consultar el acceso SIN caché (estado y módulo): se llama justo
   * antes de crear algo nuevo, porque el módulo se pudo apagar después de
   * elegir la empresa (§6.3).
   */
  sigueHabilitada(): Promise<boolean>;
}

/** La empresa no corrió por módulo o estado (no es falla ni corrida). */
const SALTEADA = Symbol('salteada');
/** La empresa está con el cortacircuito abierto. */
const ABIERTO = Symbol('abierto');

/** Diferencia de las fallas propias del proceso: el presupuesto de tiempo se agotó. */
class PresupuestoAgotado extends Error {
  constructor(ms: number) {
    super(`La empresa superó el presupuesto de ${ms} ms del tic`);
  }
}

/**
 * El recorrido único de las empresas de un proceso automático
 * (DISENO-PLATAFORMA-ORIXTECH §6.3 y §9): ninguna empresa frena ni tumba a otra.
 *
 *  - Sólo las empresas no bloqueadas y, si el proceso es de un módulo, sólo
 *    las que lo tienen habilitado (`AccesoDeLaEmpresa`). La llave de la
 *    empresa (`enabled` de `module_config`) la sigue mirando cada proceso.
 *  - Cerrojo por empresa (`lock:<proceso>:<distributorId>`): dos instancias o
 *    dos tics no procesan la misma empresa a la vez; otra empresa no espera.
 *  - Concurrencia acotada y presupuesto de tiempo por empresa: una empresa
 *    lenta ocupa un lugar hasta su presupuesto y el recorrido sigue.
 *  - Cortacircuito por empresa: tras `UMBRAL` fallas seguidas se la saltea con
 *    espera creciente (1, 2, 4… minutos, tope 1 h) y se avisa a la bandeja de
 *    la plataforma. Una corrida buena lo cierra.
 *
 * La falla de una empresa se cuenta en la corrida del proceso
 * (`registrarErrorAtrapado`): la corrida queda `partial` y las demás empresas
 * terminan igual.
 */
@Injectable()
export class EmpresasParaProceso {
  static readonly CONCURRENCIA = 4;
  static readonly PRESUPUESTO_MS = 50_000;
  static readonly UMBRAL = 3;
  static readonly ESPERA_BASE_MS = 60_000;
  static readonly ESPERA_TOPE_MS = 3_600_000;
  /** Cuánto se recuerdan las fallas seguidas de una empresa. */
  static readonly MEMORIA_SEG = 24 * 3600;

  private readonly logger = new Logger(EmpresasParaProceso.name);

  constructor(
    private readonly distribuidoras: DistributorService,
    private readonly acceso: AccesoDeLaEmpresa,
    private readonly redis: RedisService,
    private readonly eventos: EventEmitter2,
  ) {}

  async recorrer<T>(
    opciones: OpcionesDelRecorrido,
    fn: (distributorId: string, empresa: EmpresaEnCurso) => Promise<T>,
    ahora: () => number = Date.now,
  ): Promise<ResultadoDelRecorrido<T>> {
    const todas = await this.distribuidoras.findAll();
    const nombres = new Map(todas.map((d) => [d.distributorId, d.name]));
    const candidatas = opciones.entre
      ? [...new Set(opciones.entre)]
      : todas.map((d) => d.distributorId);

    // Cada candidata se decide (estado y módulo) dentro de su propio trabajo:
    // una empresa lenta al leer su acceso no frena a las demás.
    const empresas: Array<ResultadoPorEmpresa<T>> = [];
    let salteadas = 0;
    let siguiente = 0;
    const trabajador = async (): Promise<void> => {
      while (siguiente < candidatas.length) {
        const id = candidatas[siguiente++];
        const r = await this.unaEmpresa(
          id,
          nombres.get(id),
          opciones,
          fn,
          ahora,
        );
        if (r === SALTEADA) salteadas += 1;
        else empresas.push(r);
      }
    };
    const lugares = Math.max(
      1,
      Math.min(
        opciones.concurrencia ?? EmpresasParaProceso.CONCURRENCIA,
        candidatas.length,
      ),
    );
    await Promise.all(Array.from({ length: lugares }, () => trabajador()));
    return { empresas, salteadas };
  }

  /**
   * Si la empresa puede correr el proceso ahora (estado y módulo). Con
   * `fresco`, sin caché: es el chequeo de justo antes de crear algo (§6.3).
   */
  private async corre(
    distributorId: string,
    opciones: OpcionesDelRecorrido,
    fresco = false,
  ): Promise<boolean> {
    const vigente = fresco
      ? await this.acceso.calcular(distributorId)
      : await this.acceso.vigente(distributorId);
    if (vigente.nivel === 'blocked') return false;
    if (opciones.crea && vigente.nivel === 'restricted') return false;
    return !opciones.modulo || vigente.modulos.has(opciones.modulo);
  }

  private async unaEmpresa<T>(
    distributorId: string,
    nombre: string | undefined,
    opciones: OpcionesDelRecorrido,
    fn: (distributorId: string, empresa: EmpresaEnCurso) => Promise<T>,
    ahora: () => number,
  ): Promise<ResultadoPorEmpresa<T> | typeof SALTEADA> {
    const clave = `circuito:${opciones.proceso}:${distributorId}`;
    const presupuesto =
      opciones.presupuestoMs ?? EmpresasParaProceso.PRESUPUESTO_MS;
    let circuito: Circuito | null = null;
    const empresa: EmpresaEnCurso = {
      sigueHabilitada: () => this.corre(distributorId, opciones, true),
    };
    try {
      const r = await this.conPresupuesto(
        (async () => {
          circuito = await this.leerCircuito(clave);
          if (circuito && circuito.hasta > ahora()) return ABIERTO;
          if (!(await this.corre(distributorId, opciones))) return SALTEADA;
          return this.redis.withLock(
            `${opciones.proceso}:${distributorId}`,
            presupuesto + 10_000,
            () => fn(distributorId, empresa),
          );
        })(),
        presupuesto,
        distributorId,
        opciones.proceso,
      );
      if (r === SALTEADA) return SALTEADA;
      if (r === ABIERTO) return { distributorId, estado: 'circuit_open' };
      if (!r.obtenido) return { distributorId, estado: 'locked' };
      if (circuito) await this.borrarCircuito(clave);
      return { distributorId, estado: 'ok', valor: r.valor };
    } catch (error) {
      registrarErrorAtrapado(error);
      this.logger.error(
        `${opciones.proceso} ${distributorId}: ${errorMessage(error)}`,
      );
      await this.contarFalla(
        clave,
        circuito,
        distributorId,
        nombre,
        opciones,
        ahora(),
      );
      return {
        distributorId,
        estado: error instanceof PresupuestoAgotado ? 'timeout' : 'failed',
      };
    }
  }

  /**
   * Espera el trabajo hasta el presupuesto. Si se pasa, el recorrido sigue: el
   * trabajo termina por su cuenta con su cerrojo tomado (el próximo tic no lo
   * pisa) y lo que falle después sólo queda en el log.
   */
  private async conPresupuesto<T>(
    trabajo: Promise<T>,
    ms: number,
    distributorId: string,
    proceso: ProcessName,
  ): Promise<T> {
    let reloj: NodeJS.Timeout | undefined;
    const vencido = new Promise<never>((_, rechazar) => {
      reloj = setTimeout(() => rechazar(new PresupuestoAgotado(ms)), ms);
    });
    try {
      return await Promise.race([trabajo, vencido]);
    } catch (error) {
      if (error instanceof PresupuestoAgotado) {
        trabajo.catch((tarde) =>
          this.logger.error(
            `${proceso} ${distributorId}: falló después del presupuesto: ${errorMessage(tarde)}`,
          ),
        );
      }
      throw error;
    } finally {
      clearTimeout(reloj);
    }
  }

  private async leerCircuito(clave: string): Promise<Circuito | null> {
    try {
      const crudo = await this.redis.get(clave);
      return crudo ? (JSON.parse(crudo) as Circuito) : null;
    } catch (error) {
      this.logger.warn(
        `Cortacircuito no disponible (${clave}): ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async borrarCircuito(clave: string): Promise<void> {
    try {
      await this.redis.del(clave);
    } catch (error) {
      this.logger.warn(
        `No se pudo cerrar el cortacircuito ${clave}: ${errorMessage(error)}`,
      );
    }
  }

  private async contarFalla(
    clave: string,
    previo: Circuito | null,
    distributorId: string,
    nombre: string | undefined,
    opciones: OpcionesDelRecorrido,
    ahora: number,
  ): Promise<void> {
    const fallas = (previo?.fallas ?? 0) + 1;
    const exceso = fallas - EmpresasParaProceso.UMBRAL;
    const hasta =
      exceso < 0
        ? 0
        : ahora +
          Math.min(
            EmpresasParaProceso.ESPERA_BASE_MS * 2 ** exceso,
            EmpresasParaProceso.ESPERA_TOPE_MS,
          );
    try {
      await this.redis.setex(
        clave,
        EmpresasParaProceso.MEMORIA_SEG,
        JSON.stringify({ fallas, hasta } satisfies Circuito),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar el cortacircuito ${clave}: ${errorMessage(error)}`,
      );
    }
    if (exceso !== 0) return;
    const titulo = CATALOGO[opciones.proceso].title;
    const deQuien = nombre ? ` de ${nombre}` : '';
    pedirAvisoAlAdmin(this.eventos, this.logger, {
      distributorId: null,
      kind: 'process_circuit_open',
      title: `Proceso automático en pausa: ${titulo}${deQuien}`,
      body: `«${titulo}»${deQuien} falló ${fallas} veces seguidas: se saltea esa empresa con espera creciente hasta que vuelva a andar. Las demás empresas siguen corriendo.`,
      link: { entity: 'process-run', id: opciones.proceso },
      dedupeKey: `process-circuit:${opciones.proceso}:${distributorId}:${diaArgentino(new Date(ahora))}`,
    });
  }
}
