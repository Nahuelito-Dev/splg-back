import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { registrarErrorAtrapado } from '../process-run/process-run.context';
import { pedirAvisoAlAdmin } from '../common/events/aviso-al-admin';
import {
  DocumentProposal,
  DocumentReading,
  DocumentReadingStatus,
} from './entities/document-reading.entity';
import { DocumentReadingSettingsService } from './document-reading-settings.service';
import { DocumentReconciliationService } from './document-reconciliation.service';
import { AVISO_DE_NEGATIVA } from '../document-reader/document-reader.port';

@Injectable()
export class DocumentReadingProposalService {
  private readonly logger = new Logger(DocumentReadingProposalService.name);
  constructor(
    @InjectRepository(DocumentReading)
    private readonly readings: Repository<DocumentReading>,
    private readonly reconciliation: DocumentReconciliationService,
    private readonly settings: DocumentReadingSettingsService,
    private readonly events: EventEmitter2,
  ) {}

  async procesarLectura(
    reading: DocumentReading,
    now = new Date(),
  ): Promise<DocumentReading> {
    if (reading.status === DocumentReadingStatus.UNREADABLE) {
      const marcado = await this.marcarConciliada(reading, now);
      if (marcado)
        this.avisarLectura(
          reading,
          'Documento ilegible',
          reading.warnings?.includes(AVISO_DE_NEGATIVA)
            ? `${AVISO_DE_NEGATIVA}: cargá los datos a mano`
            : 'Documento ilegible: subí una imagen mejor.',
          'ilegible',
        );
      return reading;
    }
    if (reading.status === DocumentReadingStatus.DUPLICATE) {
      const marcado = await this.marcarConciliada(reading, now);
      if (marcado)
        this.avisarLectura(
          reading,
          'Documento duplicado',
          'Este documento ya se cargó en otro registro: revisá que no se pague dos veces',
          'duplicado',
        );
      return reading;
    }
    if (reading.status !== DocumentReadingStatus.READ) return reading;
    const proposal = await this.reconciliation.conciliar(reading);
    if (!proposal) {
      await this.marcarConciliada(reading, now);
      return reading;
    }
    const p = await this.settings.parametros(reading.distributorId);
    const proposalExpiresAt = new Date(
      now.getTime() + p.proposalTtlHours * 3_600_000,
    );
    const updated = await this.readings.update(
      {
        readingId: reading.readingId,
        status: DocumentReadingStatus.READ,
        reconciledAt: IsNull(),
      },
      {
        status: DocumentReadingStatus.PROPOSED,
        proposal,
        proposalExpiresAt,
        remindedAt: null,
        escalatedAt: null,
        reconciledAt: now,
      },
    );
    if (updated.affected !== 1) return reading;
    Object.assign(reading, {
      status: DocumentReadingStatus.PROPOSED,
      proposal,
      proposalExpiresAt,
      reconciledAt: now,
    });
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: reading.distributorId,
      kind: 'document_reading_proposal',
      title: 'Propuesta de conciliación pendiente',
      body: proposal.differences.length
        ? `${proposal.summary} Hay diferencias para revisar.`
        : proposal.summary,
      link: { entity: 'document-reading', id: reading.readingId },
      dedupeKey: `document-reading:${reading.readingId}:propuesta`,
    });
    return reading;
  }

  /** Reintenta las lecturas fuera de la cola, cuando el admin ya tuvo margen para completar el pago. */
  async procesarPendientesDeDistribuidora(
    distributorId: string,
    now = new Date(),
  ): Promise<number> {
    const p = await this.settings.parametros(distributorId);
    const readings = await this.readings.find({
      where: {
        distributorId,
        status: In([
          DocumentReadingStatus.READ,
          DocumentReadingStatus.UNREADABLE,
          DocumentReadingStatus.DUPLICATE,
        ]),
        reconciledAt: IsNull(),
        readAt: LessThanOrEqual(new Date(now.getTime() - 15 * 60_000)),
      },
      order: { readAt: 'ASC' },
      take: p.batchSize,
    });
    let processed = 0;
    for (const reading of readings) {
      try {
        await this.procesarLectura(reading, now);
        processed++;
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Conciliación de la lectura ${reading.readingId} falló`,
        );
      }
    }
    return processed;
  }

  async vencerDeDistribuidora(
    distributorId: string,
    now = new Date(),
  ): Promise<{ reminders: number; escalations: number }> {
    const p = await this.settings.parametros(distributorId);
    const vencidas = await this.readings.find({
      where: {
        distributorId,
        status: DocumentReadingStatus.PROPOSED,
        proposalExpiresAt: LessThanOrEqual(now),
      },
      order: { proposalExpiresAt: 'ASC' },
      take: 200,
    });
    let reminders = 0;
    let escalations = 0;
    for (const reading of vencidas) {
      if (!reading.proposal) continue;
      let proposal: DocumentProposal | null;
      try {
        proposal = await this.reconciliation.conciliar(reading);
      } catch (error) {
        // Una que no se puede volver a cruzar no frena a las demás: se reintenta en la próxima.
        registrarErrorAtrapado(error);
        this.logger.error(
          `No se pudo volver a conciliar la lectura ${reading.readingId}`,
        );
        continue;
      }
      if (!proposal) {
        await this.readings.update(
          {
            readingId: reading.readingId,
            status: DocumentReadingStatus.PROPOSED,
          },
          {
            status: DocumentReadingStatus.READ,
            proposal: null,
            proposalExpiresAt: null,
          },
        );
        continue;
      }
      // Escalada: ya no se avisa más; sólo se cierra si se resolvió afuera.
      if (reading.escalatedAt) continue;
      if (!reading.remindedAt) {
        const proposalExpiresAt = new Date(
          now.getTime() + p.reminderTtlHours * 3_600_000,
        );
        const updated = await this.readings.update(
          {
            readingId: reading.readingId,
            status: DocumentReadingStatus.PROPOSED,
            remindedAt: IsNull(),
          },
          { proposal, remindedAt: now, proposalExpiresAt },
        );
        if (updated.affected !== 1) continue;
        reminders++;
        pedirAvisoAlAdmin(this.events, this.logger, {
          distributorId,
          kind: 'document_reading_proposal',
          title: 'Recordatorio: propuesta pendiente',
          body: proposal.summary,
          link: { entity: 'document-reading', id: reading.readingId },
          dedupeKey: `document-reading:${reading.readingId}:recordatorio`,
        });
      } else {
        const updated = await this.readings.update(
          {
            readingId: reading.readingId,
            status: DocumentReadingStatus.PROPOSED,
            remindedAt: Not(IsNull()),
            escalatedAt: IsNull(),
          },
          { proposal, escalatedAt: now },
        );
        if (updated.affected !== 1) continue;
        escalations++;
        pedirAvisoAlAdmin(this.events, this.logger, {
          distributorId,
          kind: 'document_reading_proposal',
          title: 'Propuesta de conciliación escalada',
          body: `Sigue pendiente: ${proposal.summary} ${impactoDe(proposal)}`,
          link: { entity: 'document-reading', id: reading.readingId },
          dedupeKey: `document-reading:${reading.readingId}:escalado`,
          email: true,
        });
      }
    }
    return { reminders, escalations };
  }

  private async marcarConciliada(
    reading: DocumentReading,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.readings.update(
      {
        readingId: reading.readingId,
        status: reading.status,
        reconciledAt: IsNull(),
      },
      { reconciledAt: now },
    );
    return updated.affected === 1;
  }

  private avisarLectura(
    reading: DocumentReading,
    title: string,
    body: string,
    tipo: 'ilegible' | 'duplicado',
  ): void {
    pedirAvisoAlAdmin(this.events, this.logger, {
      distributorId: reading.distributorId,
      kind: 'document_reading_notice',
      title,
      body,
      link: { entity: 'document-reading', id: reading.readingId },
      dedupeKey: `document-reading:${reading.readingId}:${tipo}`,
    });
  }
}

const pesos = (v: string | null | undefined): string =>
  v
    ? `$${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`
    : 'el importe';

/** Lo que pasa si nadie responde, para el aviso escalado. */
export function impactoDe(p: DocumentProposal): string {
  switch (p.action) {
    case 'pay_installment':
      return `La cuota de ${pesos(p.expected.importe)} de ${p.expected.destinatario ?? 'la aseguradora'} sigue impaga.`;
    case 'pay_fine':
      return `La multa de ${pesos(p.expected.importe)} sigue sin pagarse y puede perder el pago voluntario.`;
    case 'update_policy':
      return p.expected.numero_de_poliza
        ? `La póliza ${p.expected.numero_de_poliza} sigue sin actualizarse con el documento.`
        : 'La póliza sigue sin actualizarse con el documento.';
    case 'register_purchase_invoice':
      return `La factura de compra por ${pesos(p.expected.total)} sigue sin registrarse.`;
    case 'update_employee_document':
      return 'El documento del personal sigue sin actualizarse y puede vencer.';
    default:
      return 'El documento sigue sin revisarse.';
  }
}
