import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { pedirAvisoAlAdmin } from '../../common/events/aviso-al-admin';
import {
  diaArgentino,
  minutosDelDiaArgentino,
  sumarDias,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import { ScheduledTasksSettingsService } from '../../distributor/scheduled-tasks-settings.service';
import { conGraciaVencida } from '../domain/insurance-rules';
import {
  DIAS_DE_AVISO_DE_CUOTA,
  DIAS_DE_AVISO_DE_POLIZA,
  InstallmentStatus,
} from '../domain/insurance.enums';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { InsurancePolicyService } from './insurance-policy.service';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { registrarErrorAtrapado } from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';

/** `2026-11-22` → `22/11/2026`. */
function fechaCorta(dia: string): string {
  const [anio, mes, d] = dia.split('-');
  return `${d}/${mes}/${anio}`;
}

function importe(n: number): string {
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function vehiculo(p: InsurancePolicy): string {
  return p.car?.carPatent ?? p.carId;
}

/**
 * Avisos del seguro de los vehículos (F14), una vez por día a la hora del aviso
 * de flota de cada distribuidora (el tic es de una hora):
 *
 * - la cuota pendiente que vence en 5 días o menos → `insurance_installment_due`;
 * - la cuota pendiente con la gracia vencida → `insurance_installment_overdue`;
 * - la póliza que vence en 30 días o menos sin otra que la reemplace →
 *   `insurance_policy_expiring`.
 *
 * Van a la bandeja del admin y por mail (`email: true`). La clave de cada aviso
 * es la cuota o la póliza, así que la bandeja no lo repite en las corridas
 * siguientes.
 */
@Injectable()
export class InsuranceAlertsCron {
  private readonly logger = new Logger(InsuranceAlertsCron.name);

  constructor(
    @InjectRepository(InsuranceInstallment)
    private readonly installments: Repository<InsuranceInstallment>,
    @InjectRepository(InsurancePolicy)
    private readonly policies: Repository<InsurancePolicy>,
    private readonly frecuencias: ScheduledTasksSettingsService,
    private readonly events: EventEmitter2,
    private readonly polizas: InsurancePolicyService,
  ) {}

  @Cron('0 * * * *', { timeZone: ZONA_ARGENTINA }) // cada hora en punto; cada distribuidora avisa a su hora (Argentina)
  @ConRegistro(ProcessName.INSURANCE_ALERTS)
  async avisar(ahora: Date = new Date()): Promise<void> {
    const hoy = diaArgentino(ahora);
    const hora = Math.floor(minutosDelDiaArgentino(ahora) / 60);
    const cuotas = await this.cuotasPorAvisar(hoy);
    const polizas = await this.polizasPorVencer(hoy);
    const pendientes = await this.distribuidorasConSincronizacionPendiente(hoy);

    const distribuidoras = new Set([
      ...cuotas.map((c) => c.distributorId),
      ...polizas.map((p) => p.distributorId),
      ...pendientes,
    ]);
    for (const distributorId of distribuidoras) {
      try {
        if (
          !(await this.frecuencias.esLaHoraDelAvisoDeFlota(distributorId, hora))
        ) {
          continue;
        }
        // Antes de avisar: una póliza que ya empezó actualiza el seguro de la flota.
        if (pendientes.includes(distributorId)) {
          await this.polizas.completarPendientes(distributorId, hoy);
        }
        for (const cuota of cuotas) {
          if (cuota.distributorId === distributorId)
            this.avisarCuota(cuota, hoy);
        }
        for (const poliza of polizas) {
          if (poliza.distributorId === distributorId) this.avisarPoliza(poliza);
        }
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `No se pudieron avisar los seguros de la distribuidora ${distributorId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** Distribuidoras con pólizas que empezaron y esperaban a que venciera el seguro de la flota. */
  private async distribuidorasConSincronizacionPendiente(
    hoy: string,
  ): Promise<string[]> {
    const pendientes = await this.policies
      .createQueryBuilder('p')
      .where('p.fleet_pending = true AND p.cancelled_at IS NULL')
      .andWhere('p.valid_from <= :hoy', { hoy })
      .getMany();
    return [...new Set(pendientes.map((p) => p.distributorId))];
  }

  private cuotasPorAvisar(hoy: string): Promise<InsuranceInstallment[]> {
    return this.installments
      .createQueryBuilder('c')
      .withDeleted() // una aseguradora dada de baja sigue mostrándose con su nombre
      .innerJoinAndSelect('c.policy', 'p')
      .innerJoinAndSelect('p.insurer', 'i')
      .leftJoinAndSelect('p.car', 'car')
      .where('c.status = :pendiente', { pendiente: InstallmentStatus.PENDING })
      .andWhere('p.cancelled_at IS NULL')
      .andWhere('c.due_date <= :limite', {
        limite: sumarDias(hoy, DIAS_DE_AVISO_DE_CUOTA),
      })
      .orderBy('c.due_date', 'ASC')
      .getMany();
  }

  /** Pólizas que vencen pronto y a las que ninguna otra póliza vigente del vehículo sigue. */
  private polizasPorVencer(hoy: string): Promise<InsurancePolicy[]> {
    return this.policies
      .createQueryBuilder('p')
      .withDeleted() // una aseguradora dada de baja sigue mostrándose con su nombre
      .innerJoinAndSelect('p.insurer', 'i')
      .leftJoinAndSelect('p.car', 'car')
      .where('p.cancelled_at IS NULL')
      .andWhere('p.valid_to >= :hoy AND p.valid_to <= :limite', {
        hoy,
        limite: sumarDias(hoy, DIAS_DE_AVISO_DE_POLIZA),
      })
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM "insurance_policy" q
           WHERE q."car_id" = p."car_id" AND q."policy_id" <> p."policy_id"
             AND q."cancelled_at" IS NULL AND q."valid_to" > p."valid_to"
             AND q."valid_from" <= p."valid_to"
         )`,
      )
      .orderBy('p.valid_to', 'ASC')
      .getMany();
  }

  private avisarCuota(cuota: InsuranceInstallment, hoy: string): void {
    const poliza = cuota.policy;
    if (!poliza) return;
    const vencida = conGraciaVencida(cuota, hoy);
    const enlace = poliza.insurer?.paymentUrl
      ? `\nEnlace de pago: ${poliza.insurer.paymentUrl}`
      : '';
    const cuerpo = `${poliza.insurer?.name ?? 'Aseguradora'} — vehículo ${vehiculo(poliza)}, cuota ${cuota.number}/${cuota.total} de ${importe(cuota.amount)}, ${vencida ? 'venció' : 'vence'} el ${fechaCorta(cuota.dueDate)} (en término hasta el ${fechaCorta(cuota.graceUntil)}).${enlace}`;
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: cuota.distributorId,
      kind: vencida
        ? 'insurance_installment_overdue'
        : 'insurance_installment_due',
      title: vencida
        ? `Cuota de seguro vencida: ${vehiculo(poliza)}`
        : `Cuota de seguro por vencer: ${vehiculo(poliza)}`,
      body: cuerpo,
      link: { entity: 'car-insurance', id: poliza.carId },
      // Con el vencimiento: si se corrige la fecha, la cuota vuelve a avisar.
      dedupeKey: `insurance-installment:${cuota.installmentId}:${vencida ? 'overdue' : 'due'}:${cuota.dueDate}`,
      email: true,
    });
  }

  private avisarPoliza(poliza: InsurancePolicy): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: poliza.distributorId,
      kind: 'insurance_policy_expiring',
      title: `Póliza por vencer: ${vehiculo(poliza)}`,
      body: `${poliza.insurer?.name ?? 'Aseguradora'} — vehículo ${vehiculo(poliza)}, póliza ${poliza.policyNumber} vence el ${fechaCorta(poliza.validTo)} y no tiene otra póliza que la reemplace.`,
      link: { entity: 'car-insurance', id: poliza.carId },
      dedupeKey: `insurance-policy:${poliza.policyId}:expiring`,
      email: true,
    });
  }
}
