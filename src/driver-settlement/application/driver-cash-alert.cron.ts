import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import {
  diaArgentino,
  minutosDelDiaArgentino,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import { dec } from '../../common/utils/dinero';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { montoEnPesos } from '../../order/domain/efectivo-a-cobrar';
import { ProcessName } from '../../process-run/domain/process-catalog';
import { EmpresasParaProceso } from '../../process-run/empresas-para-proceso';
import {
  erroresAtrapados,
  marcarSaltada,
  registrarErrorAtrapado,
} from '../../process-run/process-run.context';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { RedisService } from '../../redis/redis.service';
import {
  EfectivoSinRendirDeChofer,
  efectivoSinRendirPorChofer,
} from './settlement-orders';

export const AVISO_EFECTIVO_SIN_RENDIR = 'driver_cash_unreported';

/** Hora (0–23) en Argentina de un instante. */
export function horaArgentina(ahora: Date): number {
  return Math.floor(minutosDelDiaArgentino(ahora) / 60);
}

/** La antigüedad como la muestra el panel: «5 h», «98 d 2 h» (sin horas sueltas si son 0). */
export function antiguedadEnTexto(horas: number): string {
  if (horas < 24) return `${horas} h`;
  const dias = Math.floor(horas / 24);
  const resto = horas % 24;
  return resto === 0 ? `${dias} d` : `${dias} d ${resto} h`;
}

/** El texto del aviso: cuántos choferes, cuánto y quién lleva más tiempo. */
export function textoDelAviso(
  choferes: EfectivoSinRendirDeChofer[],
  minHours: number,
): { title: string; body: string } {
  const total = choferes.reduce((s, c) => s.plus(c.amount), dec(0)).toNumber();
  const pedidos = choferes.reduce((s, c) => s + c.orders, 0);
  const pedidosEnTexto = (n: number) =>
    n === 1 ? '1 pedido entregado' : `${n} pedidos entregados`;
  const detalle = choferes
    .slice(0, 5)
    .map(
      (c) =>
        `${c.driverName ?? 'Chofer sin nombre'}: ${montoEnPesos(c.amount)} (${pedidosEnTexto(c.orders)}, hace ${antiguedadEnTexto(c.ageHours)})`,
    )
    .join('; ');
  const resto = choferes.length > 5 ? ` y ${choferes.length - 5} más` : '';
  const quien =
    choferes.length === 1
      ? '1 chofer cobró'
      : `${choferes.length} choferes cobraron`;
  const rendido =
    choferes.length === 1 ? 'todavía no lo rindió' : 'todavía no lo rindieron';
  return {
    title: `Efectivo sin rendir: ${montoEnPesos(total)}`,
    body: `${quien} en efectivo ${pedidosEnTexto(pedidos)} hace más de ${minHours} h y ${rendido}. ${detalle}${resto}.`,
  };
}

/**
 * Al cierre del día (hora configurable por distribuidora, `cash_alerts.closeHour`)
 * avisa en la campana del administrador el efectivo cobrado hace más de
 * `cash_alerts.minHours` horas que ninguna rendición tomó. Corre cada hora y
 * actúa sólo en la hora de cada empresa; un solo aviso por distribuidora y día
 * (la `dedupeKey` lleva el día), así un reintento o dos instancias no lo repiten.
 */
@Injectable()
export class DriverCashAlertCron {
  private readonly logger = new Logger(DriverCashAlertCron.name);
  static readonly LOCK = 'cron:driver-cash-alert';

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ProcessConfigService,
    private readonly redis: RedisService,
    private readonly empresas: EmpresasParaProceso,
    private readonly events: EventEmitter2,
  ) {}

  @Cron('0 0 * * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.DRIVER_CASH_ALERT)
  async ejecutar(): Promise<void> {
    try {
      const lock = await this.redis.withLock(
        DriverCashAlertCron.LOCK,
        55 * 60_000,
        () => this.ejecutarSinCerrojo(),
      );
      if (!lock.obtenido) marcarSaltada();
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error('Aviso de efectivo sin rendir falló');
    }
  }

  async ejecutarSinCerrojo(ahora = new Date()): Promise<void> {
    const { empresas } = await this.empresas.recorrer(
      { proceso: ProcessName.DRIVER_CASH_ALERT, modulo: null },
      (distributorId) => this.avisarEmpresa(distributorId, ahora),
    );
    const avisadas = empresas.some((e) => e.valor === true);
    if (!avisadas && erroresAtrapados() === 0) marcarSaltada();
  }

  /** `true` si pidió el aviso de esa empresa. */
  private async avisarEmpresa(
    distributorId: string,
    ahora: Date,
  ): Promise<boolean> {
    const p = await this.config.obtener(
      distributorId,
      ConfigurableProcess.CASH_ALERTS,
    );
    if (p.enabled !== 1 || horaArgentina(ahora) !== p.closeHour) return false;
    const choferes = await efectivoSinRendirPorChofer(
      this.dataSource.manager,
      distributorId,
      { ahora, masViejosDeHoras: p.minHours },
    );
    if (choferes.length === 0) return false;
    const { title, body } = textoDelAviso(choferes, p.minHours);
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId,
      kind: AVISO_EFECTIVO_SIN_RENDIR,
      title,
      body,
      link: { entity: 'driver-settlement-cash', id: distributorId },
      dedupeKey: `${AVISO_EFECTIVO_SIN_RENDIR}:${diaArgentino(ahora)}`,
    });
    return true;
  }
}
