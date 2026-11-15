import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { RedisService } from '../../redis/redis.service';
import { createHash } from 'crypto';
import {
  esModulo,
  MODULOS,
  MODULOS_POR_PLAN,
  type ModuloKey,
} from '../modules/catalogo-de-modulos';
import type { LimitesDelPlan } from '../modules/entities/platform-plan.entity';

export type NivelDeAcceso = 'full' | 'warning' | 'restricted' | 'blocked';

/** Lo que la plataforma le permite hoy a una empresa (DISENO-PLATAFORMA-ORIXTECH §6.1). */
export interface AccesoVigente {
  distributorId: string;
  nivel: NivelDeAcceso;
  aceptaPedidos: boolean;
  /** Módulos habilitados (llave de la plataforma); la llave de la empresa no entra acá. */
  modulos: ReadonlySet<ModuloKey>;
  limites: LimitesDelPlan;
  motivo: string | null;
  planCode: string | null;
}

/** La forma en que se guarda en Redis (sin `Set`). */
interface AccesoEnCache extends Omit<AccesoVigente, 'modulos'> {
  modulos: ModuloKey[];
}

interface FilaDeEmpresa {
  status: string;
  deleted: boolean;
  plan_code: string | null;
  plan_snapshot: { modules?: unknown; limits?: LimitesDelPlan } | null;
}

interface FilaDeExcepcion {
  module_key: string;
  enabled: boolean;
}

const SIN_TOPES: LimitesDelPlan = {
  maxDrivers: null,
  maxAdmins: null,
  maxOrdersMonth: null,
  documentReadingUsdMonth: null,
};

export const MOTIVO_NO_DISPONIBLE =
  'La distribuidora no está tomando pedidos en este momento';

/**
 * Versión del acceso de una empresa: sube (INCR) con cada cambio. Forma parte
 * de la clave de la caché, así un valor calculado antes de un cambio queda
 * guardado bajo la versión vieja y nadie lo vuelve a leer.
 */
export const claveDeVersion = (distributorId: string): string =>
  `acceso:version:${distributorId}`;

/**
 * Huella del catálogo de módulos: dos versiones del back con catálogos
 * distintos (un despliegue escalonado, o el back de desarrollo y uno de
 * prueba sobre el mismo Redis) no comparten lo calculado. Si no, el que no
 * conoce un módulo nuevo lo guarda sin él y el otro lo lee apagado.
 */
export const HUELLA_DEL_CATALOGO = createHash('sha256')
  .update(MODULOS.join(','))
  .digest('hex')
  .slice(0, 8);

/** Clave de la caché por empresa, versión y catálogo (incluye su id, §9). */
export const claveDeAcceso = (distributorId: string, version: string): string =>
  `acceso:${distributorId}:${version}:${HUELLA_DEL_CATALOGO}`;

/**
 * La pieza única que responde «¿qué puede usar esta empresa ahora?» desde el
 * lado de la plataforma (P1: estado manual + módulos de la foto del plan +
 * excepciones vigentes). Caché Redis `acceso:<id>:<versión>` de 60 s; cambiar
 * un módulo sube la versión (`invalidar`). Si Redis no responde, se consulta
 * la base.
 *
 * Por qué versión y no DEL: una request que leyó la base antes del cambio y
 * guarda después del DEL dejaría el valor viejo por 60 s. Con la versión leída
 * ANTES de calcular, ese valor queda bajo la clave vieja.
 *
 * Habilitado(e, m) = excepción vigente ?? m ∈ foto del plan.
 * El estado comercial de la suscripción (prueba, mora, restricción) entra en P5.
 */
@Injectable()
export class AccesoDeLaEmpresa {
  static readonly TTL_SEGUNDOS = 60;
  private readonly logger = new Logger(AccesoDeLaEmpresa.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  async vigente(distributorId: string): Promise<AccesoVigente> {
    // La versión se lee ANTES de ir a la base (ver la clase).
    const version = await this.version(distributorId);
    if (version === null) return this.calcular(distributorId);
    const enCache = await this.leerCache(distributorId, version);
    if (enCache) return enCache;
    const acceso = await this.calcular(distributorId);
    await this.guardarCache(acceso, version);
    return acceso;
  }

  async habilitado(distributorId: string, modulo: ModuloKey): Promise<boolean> {
    return (await this.vigente(distributorId)).modulos.has(modulo);
  }

  async invalidar(distributorId: string): Promise<void> {
    try {
      await this.redis.incr(claveDeVersion(distributorId));
    } catch (error) {
      this.logger.warn(
        `No se pudo invalidar el acceso de ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }

  /** Lo calcula de la base, sin caché. */
  async calcular(distributorId: string): Promise<AccesoVigente> {
    const filas = await this.dataSource.query<FilaDeEmpresa[]>(
      `SELECT d."status"::text AS status, d."deletedAt" IS NOT NULL AS deleted,
              s."plan_code", s."plan_snapshot"
         FROM "distributor" d
         LEFT JOIN "distributor_subscription" s ON s."distributor_id" = d."distributor_id"
        WHERE d."distributor_id" = $1`,
      [distributorId],
    );
    const empresa = filas[0];
    if (!empresa || empresa.deleted || empresa.status !== 'active') {
      return {
        distributorId,
        nivel: 'blocked',
        aceptaPedidos: false,
        modulos: new Set(),
        limites: empresa?.plan_snapshot?.limits ?? SIN_TOPES,
        motivo: MOTIVO_NO_DISPONIBLE,
        planCode: empresa?.plan_code ?? null,
      };
    }
    const modulos = new Set<ModuloKey>(this.modulosDeLaFoto(empresa));
    const excepciones = await this.dataSource.query<FilaDeExcepcion[]>(
      `SELECT "module_key", "enabled"
         FROM "distributor_module"
        WHERE "distributor_id" = $1 AND "enabled" IS NOT NULL
          AND ("expires_at" IS NULL OR "expires_at" > now())`,
      [distributorId],
    );
    for (const e of excepciones) {
      if (!esModulo(e.module_key)) continue;
      if (e.enabled) modulos.add(e.module_key);
      else modulos.delete(e.module_key);
    }
    return {
      distributorId,
      nivel: 'full',
      aceptaPedidos: true,
      modulos,
      limites: empresa.plan_snapshot?.limits ?? SIN_TOPES,
      motivo: null,
      planCode: empresa.plan_code,
    };
  }

  /**
   * Los módulos de la foto del plan. Sin suscripción (no debería pasar: la crea
   * un trigger al dar de alta la empresa) rige `full`, igual que la migración:
   * la falta de la fila nunca apaga nada.
   */
  private modulosDeLaFoto(empresa: FilaDeEmpresa): ModuloKey[] {
    const modulos = empresa.plan_snapshot?.modules;
    if (!Array.isArray(modulos)) {
      this.logger.warn(
        'Empresa sin suscripción o con la foto del plan incompleta: rige el plan completo',
      );
      return [...MODULOS_POR_PLAN.full];
    }
    return modulos.filter(
      (m): m is ModuloKey => typeof m === 'string' && esModulo(m),
    );
  }

  /** La versión vigente (`'0'` si nunca cambió), o `null` si Redis no responde. */
  private async version(distributorId: string): Promise<string | null> {
    try {
      return (await this.redis.get(claveDeVersion(distributorId))) ?? '0';
    } catch (error) {
      this.logger.warn(
        `Caché de acceso no disponible (${distributorId}): ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async leerCache(
    distributorId: string,
    version: string,
  ): Promise<AccesoVigente | null> {
    try {
      const crudo = await this.redis.get(claveDeAcceso(distributorId, version));
      if (!crudo) return null;
      const guardado = JSON.parse(crudo) as AccesoEnCache;
      return { ...guardado, modulos: new Set(guardado.modulos) };
    } catch (error) {
      this.logger.warn(
        `Caché de acceso no disponible (${distributorId}): ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private async guardarCache(
    acceso: AccesoVigente,
    version: string,
  ): Promise<void> {
    try {
      const guardado: AccesoEnCache = {
        ...acceso,
        modulos: [...acceso.modulos],
      };
      await this.redis.setex(
        claveDeAcceso(acceso.distributorId, version),
        AccesoDeLaEmpresa.TTL_SEGUNDOS,
        JSON.stringify(guardado),
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar el acceso de ${acceso.distributorId} en la caché: ${errorMessage(error)}`,
      );
    }
  }
}
