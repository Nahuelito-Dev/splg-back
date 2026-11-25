import { Injectable, NotFoundException } from '@nestjs/common';
import { FUERA_DEL_DEPOSITO } from '../domain/cylinder-state';
import {
  EstadoDeVigencia,
  Vigencia,
  calcularVigencia,
} from '../domain/cylinder-vigencia';
import { ClockPort } from '../domain/ports/clock.port';
import {
  CylinderQueryPort,
  EnvaseVista,
  FiltrosDeEnvases,
  GrupoDeVencimiento,
  MovimientoVista,
  RevisionVista,
} from '../domain/ports/cylinder-query.port';
import { normalizarSerial } from '../domain/serial-de-envase';

const MS_POR_DIA = 24 * 60 * 60 * 1000;

export interface VigenciaDeEnvase {
  cylinder: EnvaseVista;
  vigencia: Vigencia;
  /** Vencido y todavía afuera: se retira cuando vuelva. */
  retiroPendiente: boolean;
  /** De la más reciente a la más antigua. */
  inspections: RevisionVista[];
}

export interface EnvaseConVigencia {
  cylinder: EnvaseVista;
  vigencia: Vigencia;
}

export interface VencimientosDelParque {
  windowDays: number;
  /** Total de cada grupo, sin paginar. */
  totals: { expired: number; expiring: number; unverified: number };
  expired: EnvaseConVigencia[];
  expiring: EnvaseConVigencia[];
  unverified: EnvaseConVigencia[];
}

/**
 * Lecturas de envases: listado, detalle, historial y vigencia (C-11). La
 * vigencia se calcula con la misma regla del dominio que bloquea el despacho.
 */
@Injectable()
export class CylinderQueryService {
  constructor(
    private readonly consultas: CylinderQueryPort,
    private readonly reloj: ClockPort,
  ) {}

  /** Listado con filtros; acotado a la distribuidora si se pasa. Página y total sin paginar. */
  findAll(
    distributorId?: string | null,
    filtros: FiltrosDeEnvases = {},
  ): Promise<[EnvaseVista[], number]> {
    // El mismo reloj que usa el bloqueo del despacho.
    return this.consultas.listar(distributorId, filtros, this.reloj.ahora());
  }

  async findOne(
    id: string,
    distributorId?: string | null,
  ): Promise<EnvaseVista> {
    const envase = await this.consultas.buscarPorId(id, distributorId);
    if (!envase) throw new NotFoundException('Envase no encontrado');
    return envase;
  }

  async findBySerial(
    serial: string,
    distributorId: string,
  ): Promise<EnvaseVista> {
    const envase = await this.consultas.buscarPorSerial(
      normalizarSerial(serial),
      distributorId,
    );
    if (!envase) throw new NotFoundException('Envase no encontrado');
    return envase;
  }

  /** Historial de movimientos, en orden cronológico. */
  async getHistory(
    id: string,
    distributorId?: string | null,
  ): Promise<MovimientoVista[]> {
    // Valida existencia (y distribuidora) antes de listar el historial.
    await this.findOne(id, distributorId);
    return this.consultas.historial(id);
  }

  /** CU-133. Vigencia de un envase por id. */
  async getVigencia(
    cylinderId: string,
    distributorId?: string | null,
  ): Promise<VigenciaDeEnvase> {
    const envase = await this.consultas.buscarConProducto(
      { cylinderId },
      distributorId,
    );
    if (!envase) throw new NotFoundException('Envase no encontrado');
    return this.armar(envase);
  }

  /** CU-133. Vigencia de un envase por su número de serie (lo que se escanea). */
  async getVigenciaBySerial(
    serial: string,
    distributorId?: string | null,
  ): Promise<VigenciaDeEnvase> {
    const envase = await this.consultas.buscarConProducto(
      { serial: normalizarSerial(serial) },
      distributorId,
    );
    if (!envase) throw new NotFoundException('Envase no encontrado');
    return this.armar(envase);
  }

  /**
   * CU-134. Envases que vencen dentro de la ventana, los ya vencidos y los que
   * no tienen revisión registrada (aparte, sin fecha con la cual comparar). Los
   * dados de baja no cuentan: ya no circulan.
   */
  async findExpiring(
    days: number,
    distributorId?: string | null,
    limit = 100,
    offset = 0,
  ): Promise<VencimientosDelParque> {
    const ahora = this.reloj.ahora();
    const limite = new Date(ahora.getTime() + days * MS_POR_DIA);
    const grupo = async (
      cual: GrupoDeVencimiento,
    ): Promise<[EnvaseConVigencia[], number]> => {
      const [envases, total] = await this.consultas.vencimientos(cual, {
        ahora,
        limite,
        distributorId,
        limit,
        offset,
      });
      return [
        envases.map((cylinder) => ({
          cylinder,
          vigencia: calcularVigencia(cylinder.expiresAt, ahora),
        })),
        total,
      ];
    };

    const [expired, totalExpired] = await grupo('expired');
    const [expiring, totalExpiring] = await grupo('expiring');
    const [unverified, totalUnverified] = await grupo('unverified');
    return {
      windowDays: days,
      totals: {
        expired: totalExpired,
        expiring: totalExpiring,
        unverified: totalUnverified,
      },
      expired,
      expiring,
      unverified,
    };
  }

  private async armar(cylinder: EnvaseVista): Promise<VigenciaDeEnvase> {
    const vigencia = calcularVigencia(cylinder.expiresAt, this.reloj.ahora());
    const inspections = await this.consultas.revisiones(cylinder.cylinderId);
    return {
      cylinder,
      vigencia,
      inspections,
      retiroPendiente:
        vigencia.estado === EstadoDeVigencia.VENCIDO &&
        FUERA_DEL_DEPOSITO.includes(cylinder.state),
    };
  }
}
