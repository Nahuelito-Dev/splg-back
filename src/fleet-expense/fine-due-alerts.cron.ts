import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage } from '../common/errors/error-message';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import {
  diaArgentino,
  minutosDelDiaArgentino,
  sumarDias,
  ZONA_ARGENTINA,
} from '../common/utils/dias-argentina';
import { ScheduledTasksSettingsService } from '../distributor/scheduled-tasks-settings.service';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';

/** Se avisan las multas que vencen en esta cantidad de días o menos, y las ya vencidas. */
export const DIAS_DE_ANTICIPACION_DE_MULTAS = 5;

/** Las vencidas hace más que esto ya no se avisan: es historia, no una alerta. */
export const DIAS_DE_VENCIDA_QUE_SE_AVISAN = 30;

/** `2026-11-22` → `22/11/2026`. */
function fechaCorta(dia: string): string {
  const [anio, mes, d] = dia.split('-');
  return `${d}/${mes}/${anio}`;
}

function importe(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * CU-326: una vez por día, a la hora del aviso de flota de cada distribuidora
 * (el tic es de una hora), avisa por la bandeja del admin —y por mail— las
 * multas pendientes que vencen en cinco días o menos (`traffic_fine_due`) o ya
 * vencieron sin pagar (`traffic_fine_overdue`). La clave de cada aviso lleva la
 * multa, el tipo y el vencimiento: la bandeja no repite el aviso, y si se corrige
 * la fecha la multa vuelve a avisar.
 *
 * Sólo se avisan las que no tienen `alerted_at` (las que ya avisó el correo anterior no se repiten) y vencieron
 * hace 30 días o menos. Sólo se avisan las `pending`: una apelada está en discusión (si la apelación
 * se rechaza, se corrige la fecha y vuelve a entrar).
 */
@Injectable()
export class FineDueAlertsCron {
  private readonly logger = new Logger(FineDueAlertsCron.name);

  constructor(
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    private readonly frecuencias: ScheduledTasksSettingsService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron('0 * * * *', { timeZone: ZONA_ARGENTINA }) // cada hora en punto; cada distribuidora avisa a su hora (Argentina)
  async avisarMultasPorVencer(ahora: Date = new Date()): Promise<void> {
    const hoy = diaArgentino(ahora);
    const hora = Math.floor(minutosDelDiaArgentino(ahora) / 60);
    const multas = await this.fines
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.car', 'car')
      .where('m.status = :pendiente', { pendiente: TrafficFineStatus.PENDING })
      // Las que el aviso por correo anterior ya avisó (`alerted_at`) no se repiten por la bandeja al desplegar.
      .andWhere('m.alerted_at IS NULL')
      .andWhere('m.due_date >= :piso', {
        piso: sumarDias(hoy, -DIAS_DE_VENCIDA_QUE_SE_AVISAN),
      })
      .andWhere('m.due_date <= :limite', {
        limite: sumarDias(hoy, DIAS_DE_ANTICIPACION_DE_MULTAS),
      })
      .orderBy('m.due_date', 'ASC')
      .getMany();

    const habilitadas = new Map<string, boolean>();
    for (const multa of multas) {
      try {
        let toca = habilitadas.get(multa.distributorId);
        if (toca === undefined) {
          toca = await this.frecuencias.esLaHoraDelAvisoDeFlota(
            multa.distributorId,
            hora,
          );
          habilitadas.set(multa.distributorId, toca);
        }
        if (toca) this.avisar(multa, hoy);
      } catch (error) {
        this.logger.error(
          `No se pudo avisar la multa ${multa.fineId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private avisar(multa: TrafficFine, hoy: string): void {
    if (!multa.dueDate) return;
    const vencida = multa.dueDate < hoy;
    const patente = multa.car?.carPatent ?? multa.carId;
    // El pago voluntario sólo vale hasta el vencimiento.
    const voluntario =
      !vencida && multa.voluntaryPaymentAmount !== null
        ? ` (con pago voluntario ${importe(multa.voluntaryPaymentAmount)})`
        : '';
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: multa.distributorId,
      kind: vencida ? 'traffic_fine_overdue' : 'traffic_fine_due',
      title: vencida
        ? `Multa vencida sin pagar: ${patente}`
        : `Multa por vencer: ${patente}`,
      body: `Acta ${multa.actNumber} (${multa.jurisdiction}) — vehículo ${patente}, ${importe(multa.amount)}${voluntario}, ${vencida ? 'venció' : 'vence'} el ${fechaCorta(multa.dueDate)}.${multa.paymentUrl ? `\nEnlace de pago: ${multa.paymentUrl}` : ''}`,
      link: { entity: 'traffic-fine', id: multa.fineId },
      dedupeKey: `traffic-fine:${multa.fineId}:${vencida ? 'overdue' : 'due'}:${multa.dueDate}`,
      email: true,
    });
  }
}
