import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminService } from '../admin/admin.service';
import { errorMessage } from '../common/errors/error-message';
import { diaArgentino, ZONA_ARGENTINA } from '../common/utils/dias-argentina';
import { EmailSenderPort } from '../email/ports/email-sender.port';
import { TrafficFine, TrafficFineStatus } from './entities/traffic-fine.entity';

/** Se avisan las multas que vencen en esta cantidad de días o menos, y las ya vencidas. */
export const DIAS_DE_ANTICIPACION_DE_MULTAS = 7;

/**
 * CU-326: cada día a las 8 (hora argentina) avisa por correo a los
 * administradores de cada distribuidora las multas pendientes que vencen en
 * siete días o menos, o ya vencieron, y marca cada una como avisada para no
 * repetir. Si el envío falla no marca nada: se reintenta en la corrida
 * siguiente. Misma mecánica que el aviso de vencimientos de flota (CU-142).
 */
@Injectable()
export class FineDueAlertsCron {
  private readonly logger = new Logger(FineDueAlertsCron.name);

  constructor(
    @InjectRepository(TrafficFine)
    private readonly fines: Repository<TrafficFine>,
    private readonly admins: AdminService,
    private readonly emailSender: EmailSenderPort,
  ) {}

  @Cron('0 8 * * *', { timeZone: ZONA_ARGENTINA })
  async avisarMultasPorVencer(ahora: Date = new Date()): Promise<void> {
    const limite = diaArgentino(
      new Date(ahora.getTime() + DIAS_DE_ANTICIPACION_DE_MULTAS * 86_400_000),
    );
    const multas = await this.fines
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.car', 'car')
      .where('m.status = :pendiente', { pendiente: TrafficFineStatus.PENDING })
      .andWhere('m.alerted_at IS NULL AND m.due_date IS NOT NULL')
      .andWhere('m.due_date <= :limite', { limite })
      .orderBy('m.due_date', 'ASC')
      .getMany();

    const porDistribuidora = new Map<string, TrafficFine[]>();
    for (const multa of multas) {
      const lista = porDistribuidora.get(multa.distributorId) ?? [];
      lista.push(multa);
      porDistribuidora.set(multa.distributorId, lista);
    }
    for (const [distributorId, lista] of porDistribuidora) {
      await this.avisar(distributorId, lista, ahora);
    }
  }

  private async avisar(
    distributorId: string,
    multas: TrafficFine[],
    ahora: Date,
  ): Promise<void> {
    try {
      const admins = await this.admins.findAll(distributorId);
      const destinatarios = admins
        .map((a) => a.user?.email)
        .filter((email): email is string => Boolean(email));
      if (destinatarios.length > 0) {
        const html = this.armarHtml(multas);
        await Promise.all(
          destinatarios.map((to) =>
            this.emailSender.send({
              to,
              subject: `Multas por vencer: ${multas.length} pendiente(s)`,
              html,
            }),
          ),
        );
      }
      // Sin admins con correo no hay a quién avisar una segunda vez: se marca igual.
      await this.fines.update(
        multas.map((m) => m.fineId),
        { alertedAt: ahora },
      );
    } catch (error) {
      this.logger.error(
        `No se pudo avisar las multas por vencer de la distribuidora ${distributorId}: ${errorMessage(error)}`,
      );
    }
  }

  private armarHtml(multas: TrafficFine[]): string {
    const hoy = diaArgentino();
    const filas = multas
      .map((m) => {
        const vence = m.dueDate ?? '-';
        const estado =
          m.dueDate && m.dueDate < hoy ? 'VENCIDA' : `vence ${vence}`;
        return `<li>Vehículo ${m.car?.carPatent ?? m.carId} — acta ${m.actNumber} (${m.jurisdiction}) — $${m.amount} — ${estado}</li>`;
      })
      .join('');
    return `<p>Estas multas de tránsito necesitan atención:</p><ul>${filas}</ul>`;
  }
}
