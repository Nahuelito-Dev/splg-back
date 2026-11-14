import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DistributorService } from '../../distributor/distributor.service';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import type {
  AccesoDeLaEmpresa,
  AccesoVigente,
} from '../../platform/access/acceso-de-la-empresa.service';
import {
  MODULOS,
  type ModuloKey,
} from '../../platform/modules/catalogo-de-modulos';
import type { RedisService } from '../../redis/redis.service';
import { EmpresasParaProceso } from '../empresas-para-proceso';

interface EmpresaDePrueba {
  distributorId: string;
  name?: string;
  status?: DistributorStatus | string;
}

export interface OpcionesDePrueba {
  /** El mock de `DistributorService` que ya usa el spec (sólo `findAll`). */
  distribuidoras: { findAll: () => Promise<EmpresaDePrueba[]> };
  /** Qué módulo tiene habilitado cada empresa; por omisión, todos. */
  habilitado?: (distributorId: string, modulo: ModuloKey) => boolean;
}

/** Un Redis en memoria con lo que usan el recorrido y el acceso: get, setex, incr, del y cerrojo. */
export class RedisEnMemoria {
  readonly valores = new Map<string, string>();
  readonly cerrojos = new Set<string>();

  get(clave: string): Promise<string | null> {
    return Promise.resolve(this.valores.get(clave) ?? null);
  }

  setex(clave: string, _ttl: number, valor: string): Promise<void> {
    this.valores.set(clave, valor);
    return Promise.resolve();
  }

  incr(clave: string): Promise<number> {
    const n = Number(this.valores.get(clave) ?? '0') + 1;
    this.valores.set(clave, String(n));
    return Promise.resolve(n);
  }

  del(clave: string): Promise<void> {
    this.valores.delete(clave);
    return Promise.resolve();
  }

  async withLock<T>(
    clave: string,
    _ttl: number,
    fn: () => Promise<T>,
  ): Promise<{ obtenido: true; valor: T } | { obtenido: false }> {
    if (this.cerrojos.has(clave)) return { obtenido: false };
    this.cerrojos.add(clave);
    try {
      return { obtenido: true, valor: await fn() };
    } finally {
      this.cerrojos.delete(clave);
    }
  }
}

/**
 * El `EmpresasParaProceso` real para los specs de los crons, armado con las
 * distribuidoras del spec: una no activa queda bloqueada y cada empresa tiene
 * los módulos que diga `habilitado`, leídos con caché como el real (`vigente`)
 * y sin caché (`calcular`). Redis en memoria, sin avisos.
 */
export function empresasDePrueba(opciones: OpcionesDePrueba): {
  empresas: EmpresasParaProceso;
  acceso: AccesoDeLaEmpresa;
  redis: RedisEnMemoria;
} {
  const redis = new RedisEnMemoria();
  const habilitado = opciones.habilitado ?? (() => true);
  const calcular = async (distributorId: string): Promise<AccesoVigente> => {
    const empresa = (await opciones.distribuidoras.findAll()).find(
      (d) => d.distributorId === distributorId,
    );
    const activa =
      !empresa?.status ||
      String(empresa.status) === String(DistributorStatus.ACTIVE);
    return {
      distributorId,
      nivel: activa ? 'full' : 'blocked',
      aceptaPedidos: activa,
      modulos: new Set(
        activa ? MODULOS.filter((m) => habilitado(distributorId, m)) : [],
      ),
      limites: {
        maxDrivers: null,
        maxAdmins: null,
        maxOrdersMonth: null,
        documentReadingUsdMonth: null,
      },
      motivo: null,
      planCode: 'full',
    };
  };
  // Como el real: `vigente` y `habilitado` leen la caché (hasta `invalidar`);
  // `calcular` va siempre a la «base».
  const cache = new Map<string, AccesoVigente>();
  const acceso = {
    calcular,
    vigente: async (distributorId: string): Promise<AccesoVigente> => {
      const guardado = cache.get(distributorId);
      if (guardado) return guardado;
      const nuevo = await calcular(distributorId);
      cache.set(distributorId, nuevo);
      return nuevo;
    },
    habilitado: async (distributorId: string, modulo: ModuloKey) =>
      (await acceso.vigente(distributorId)).modulos.has(modulo),
    invalidar: (distributorId: string): Promise<void> => {
      cache.delete(distributorId);
      return Promise.resolve();
    },
  };
  const empresas = new EmpresasParaProceso(
    opciones.distribuidoras as unknown as DistributorService,
    acceso as unknown as AccesoDeLaEmpresa,
    redis as unknown as RedisService,
    { emit: () => true } as unknown as EventEmitter2,
  );
  return {
    empresas,
    acceso: acceso as unknown as AccesoDeLaEmpresa,
    redis,
  };
}
