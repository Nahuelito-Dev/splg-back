import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import Decimal from 'decimal.js';

import { normalizarCampo } from '../document-reader/claude-document-reader';
import {
  camposDe,
  TipoDeDocumento,
} from '../document-reader/tipos-de-documento';
import { TrafficFinePaymentService } from '../fleet-expense/traffic-fine-payment.service';
import { InsuranceInstallmentService } from '../insurance/application/insurance-installment.service';
import { ETIQUETAS_CAMPOS } from '../common/validation/etiquetas-campos';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import {
  ConfirmDocumentReadingDto,
  CorrectDocumentReadingDto,
  RejectDocumentReadingDto,
} from './dto/document-reading.dto';
import { DocumentReadingExample } from './entities/document-reading-example.entity';
import {
  DocumentProposalAction,
  DocumentReading,
  DocumentReadingCorrection,
  DocumentReadingStatus,
} from './entities/document-reading.entity';

/** Acciones que, al confirmar, registran un pago con su egreso en Caja. */
const ACCIONES_DE_PAGO: ReadonlySet<DocumentProposalAction> = new Set([
  'pay_installment',
  'pay_fine',
]);

const YA_RESUELTA = 'La propuesta ya fue resuelta';
const CAMBIO = 'La propuesta cambió: volvé a abrirla';
const SIN_PROPUESTA = 'La lectura no tiene una propuesta pendiente';

/** «fecha_de_pago» → «Fecha de pago» (o la etiqueta del repo, si la hay). */
const etiquetaDelCampo = (campo: string): string => {
  const texto = Object.hasOwn(ETIQUETAS_CAMPOS, campo)
    ? ETIQUETAS_CAMPOS[campo]
    : campo.replace(/_/g, ' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
};
const PISTAS: Readonly<Record<string, string>> = {
  importe: ' (usá punto decimal y sin separador de miles, p. ej. 29958.00)',
  total: ' (usá punto decimal y sin separador de miles, p. ej. 29958.00)',
  fecha_de_pago: ' (AAAA-MM-DD, con hora si la tiene)',
};
const CAMPOS_DE_FORMATO = new Set([
  'cuit_del_emisor',
  'cuit_del_destinatario',
  'destinatario',
  'patente',
  'numero_de_poliza',
  'titular',
  'documento',
]);

interface Decision {
  status:
    | DocumentReadingStatus.CONFIRMED
    | DocumentReadingStatus.CORRECTED
    | DocumentReadingStatus.REJECTED;
  cambios: Record<string, string>;
  cashBoxId?: string;
  nota: string | null;
}

/**
 * Lo que decide el administrador sobre una propuesta del módulo M6: confirmar,
 * corregir (y confirmar) o rechazar. Confirmar un pago lo registra con los
 * servicios de cuotas y multas (egreso en Caja incluido); las correcciones
 * quedan como ejemplos para las lecturas siguientes del mismo tipo.
 */
@Injectable()
export class DocumentReadingDecisionService {
  private readonly logger = new Logger(DocumentReadingDecisionService.name);

  constructor(
    @InjectRepository(DocumentReading)
    private readonly readings: Repository<DocumentReading>,
    @InjectRepository(DocumentReadingExample)
    private readonly examples: Repository<DocumentReadingExample>,
    private readonly installments: InsuranceInstallmentService,
    private readonly fines: TrafficFinePaymentService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async confirmar(
    id: string,
    dto: ConfirmDocumentReadingDto,
    distributorId: string,
    userId: string,
  ): Promise<DocumentReading> {
    return this.decidir(id, distributorId, userId, {
      status: DocumentReadingStatus.CONFIRMED,
      cambios: {},
      cashBoxId: dto.cashBoxId,
      nota: null,
    });
  }

  async corregir(
    id: string,
    dto: CorrectDocumentReadingDto,
    distributorId: string,
    userId: string,
  ): Promise<DocumentReading> {
    return this.decidir(id, distributorId, userId, {
      status: DocumentReadingStatus.CORRECTED,
      cambios: dto.fields,
      cashBoxId: dto.cashBoxId,
      nota: dto.note?.trim() || null,
    });
  }

  async rechazar(
    id: string,
    dto: RejectDocumentReadingDto,
    distributorId: string,
    userId: string,
  ): Promise<DocumentReading> {
    const motivo = dto.reason?.trim();
    if (!motivo) {
      throw new BadRequestException('Motivo del rechazo: es obligatorio');
    }
    return this.decidir(id, distributorId, userId, {
      status: DocumentReadingStatus.REJECTED,
      cambios: {},
      nota: motivo,
    });
  }

  private async decidir(
    id: string,
    distributorId: string,
    userId: string,
    decision: Decision,
  ): Promise<DocumentReading> {
    const lectura = await this.readings.findOne({
      where: { readingId: id, distributorId },
    });
    if (!lectura) throw new NotFoundException('Lectura no encontrada');
    if (lectura.status !== DocumentReadingStatus.PROPOSED || !lectura.proposal)
      throw new ConflictException(
        lectura.decidedAt ? YA_RESUELTA : SIN_PROPUESTA,
      );
    const propuesta = lectura.proposal;

    if (
      decision.status === DocumentReadingStatus.CONFIRMED &&
      propuesta.differences.some(
        (d) => d.field === 'importe' || d.field === 'fecha_de_pago',
      )
    ) {
      const field = propuesta.differences.find(
        (d) => d.field === 'importe' || d.field === 'fecha_de_pago',
      )?.field;
      throw new BadRequestException(
        `Hay diferencias en ${field === 'importe' ? 'el importe del comprobante' : 'la fecha de pago'}: corregí el dato o rechazá la propuesta`,
      );
    }

    if (decision.status === DocumentReadingStatus.CORRECTED) {
      for (const diferencia of propuesta.differences.filter(
        (d) => d.field === 'importe' || d.field === 'fecha_de_pago',
      )) {
        if (!(diferencia.field in decision.cambios)) {
          throw new BadRequestException(
            diferencia.field === 'importe'
              ? 'Hay diferencias en el importe del comprobante: indicá el importe correcto'
              : 'Hay diferencias en la fecha de pago: indicá la fecha correcta',
          );
        }
      }
    }

    // Todo lo que se puede validar, antes de tomar la propuesta.
    const leidos = Object.fromEntries(
      lectura.fields.map((f) => [f.nombre, f.valor]),
    );
    const correcciones = this.correcciones(lectura, leidos, decision);
    const valores: Record<string, string | null> = { ...leidos };
    for (const c of correcciones) valores[c.field] = c.value;
    const paga =
      decision.status !== DocumentReadingStatus.REJECTED &&
      ACCIONES_DE_PAGO.has(propuesta.action);
    const pago = paga ? this.datosDelPago(lectura, valores, decision) : null;

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Reclamo condicional: dos decisiones (o el cron) no resuelven la misma propuesta.
        const tomada = await manager.update(
          DocumentReading,
          {
            readingId: id,
            distributorId,
            status: DocumentReadingStatus.PROPOSED,
            // Si el cron recordó o escaló la propuesta desde que se leyó, la decisión fue
            // sobre otra versión. El vencimiento se escribe siempre desde JS (milisegundos),
            // así que compararlo por igualdad es exacto.
            proposalExpiresAt: lectura.proposalExpiresAt ?? IsNull(),
            remindedAt: lectura.remindedAt ? Not(IsNull()) : IsNull(),
            escalatedAt: lectura.escalatedAt ? Not(IsNull()) : IsNull(),
          },
          {
            status: decision.status,
            decidedAt: new Date(),
            decidedByUserId: userId,
            decisionNote: decision.nota,
            corrections:
              decision.status === DocumentReadingStatus.CORRECTED
                ? correcciones
                : null,
            executed: false,
          },
        );
        if (tomada.affected !== 1) {
          const ahora = await manager.findOne(DocumentReading, {
            where: { readingId: id, distributorId },
          });
          throw new ConflictException(
            ahora?.status === DocumentReadingStatus.PROPOSED
              ? CAMBIO
              : ahora?.decidedAt
                ? YA_RESUELTA
                : SIN_PROPUESTA,
          );
        }

        if (pago) {
          if (propuesta.action === 'pay_installment')
            await this.installments.pagarEn(
              manager,
              propuesta.ownerId,
              pago,
              distributorId,
              userId,
            );
          else
            await this.fines.pagarEn(
              manager,
              propuesta.ownerId,
              pago,
              distributorId,
              userId,
            );
          await manager.update(
            DocumentReading,
            { readingId: id, distributorId, status: decision.status },
            { executed: true },
          );
        }

        if (lectura.detectedType) {
          // Aceptar lo leído no enseña nada: sólo se aprende de un valor que cambió.
          const aprendibles = correcciones.filter(
            (c) => CAMPOS_DE_FORMATO.has(c.field) && c.value !== c.read,
          );
          if (aprendibles.length) {
            await manager.save(
              DocumentReadingExample,
              aprendibles.map((c) =>
                manager.create(DocumentReadingExample, {
                  distributorId,
                  documentType: lectura.detectedType!,
                  field: c.field,
                  readValue: c.read,
                  correctValue: c.value,
                  sourceReadingId: id,
                }),
              ),
            );
          }
        }

        const decidida = await manager.findOne(DocumentReading, {
          where: { readingId: id, distributorId },
        });
        if (!decidida) throw new NotFoundException('Lectura no encontrada');
        return decidida;
      });
    } catch (error) {
      return traducirErrorDeBase(
        error,
        this.logger,
        propuesta.action === 'pay_installment'
          ? 'cuotas de seguro'
          : propuesta.action === 'pay_fine'
            ? 'multas'
            : 'decisión de lectura',
      );
    }
  }

  /** Los campos que el admin cambió, validados con las mismas reglas del lector. */
  private correcciones(
    lectura: DocumentReading,
    leidos: Record<string, string | null>,
    decision: Decision,
  ): DocumentReadingCorrection[] {
    if (decision.status !== DocumentReadingStatus.CORRECTED) return [];
    const entradas = Object.entries(decision.cambios ?? {});
    if (entradas.length === 0) {
      throw new BadRequestException(
        'Campos: indicá al menos un dato corregido',
      );
    }
    const tipo: TipoDeDocumento | null =
      lectura.detectedType ?? lectura.expectedType;
    const permitidos = new Set(tipo ? camposDe(tipo).map((c) => c.nombre) : []);
    const salida: DocumentReadingCorrection[] = [];
    for (const [campo, crudo] of entradas) {
      if (typeof crudo !== 'string') {
        throw new BadRequestException(
          `${etiquetaDelCampo(campo)}: tiene que ser texto`,
        );
      }
      if (crudo.length > 200) {
        throw new BadRequestException(
          'Campos corregidos: cada valor puede tener hasta 200 caracteres',
        );
      }
      if (!permitidos.has(campo)) {
        throw new BadRequestException(
          `Campos: «${campo}» no es un dato de este tipo de documento`,
        );
      }
      const { campo: normalizado, aviso } = normalizarCampo({
        nombre: campo,
        valor: typeof crudo === 'string' ? crudo : null,
        confianza: 'alta',
      });
      if (aviso || !normalizado.valor) {
        throw new BadRequestException(
          `${etiquetaDelCampo(campo)}: el valor «${String(crudo)}» no es válido${PISTAS[campo] ?? ''}`,
        );
      }
      const leido = leidos[campo] ?? null;
      const valor = valorNormalizado(campo, normalizado.valor);
      const esAceptacion = lectura.proposal?.differences.some(
        (d) => d.field === campo,
      );
      if (!sonIguales(campo, valor, leido) || esAceptacion) {
        salida.push({
          field: campo,
          read: leido,
          value: valor,
        });
      }
    }
    if (!salida.length) {
      throw new BadRequestException('No cambiaste ningún dato: usá confirmar');
    }
    return salida;
  }

  private datosDelPago(
    lectura: DocumentReading,
    valores: Record<string, string | null>,
    decision: Decision,
  ) {
    if ((valores['numero_de_operacion']?.length ?? 0) > 60) {
      throw new BadRequestException('Número de operación: hasta 60 caracteres');
    }
    const importe = Number(valores['importe']);
    if (!valores['importe'] || !Number.isFinite(importe) || importe <= 0) {
      throw new BadRequestException(
        'Importe: falta el importe del pago (corregilo para confirmar)',
      );
    }
    if (!valores['fecha_de_pago']) {
      throw new BadRequestException(
        'Fecha de pago: falta la fecha del pago (corregila para confirmar)',
      );
    }
    if (!decision.cashBoxId) {
      throw new BadRequestException('Caja: indicá la caja del pago');
    }
    return {
      attachmentId: lectura.attachmentId,
      amount: importe,
      paidAt: valores['fecha_de_pago'],
      operationNumber: valores['numero_de_operacion'] ?? null,
      cashBoxId: decision.cashBoxId,
    };
  }
}

const CAMPOS_MONETARIOS = new Set(['importe', 'total', 'iva', 'prima']);
const CAMPOS_DE_FECHA = new Set([
  'fecha',
  'fecha_de_revision',
  'vencimiento',
  'vigencia_desde',
  'vigencia_hasta',
]);

function valorNormalizado(campo: string, valor: string): string {
  return CAMPOS_MONETARIOS.has(campo) ? new Decimal(valor).toFixed(2) : valor;
}

function sonIguales(campo: string, a: string, b: string | null): boolean {
  if (b === null) return false;
  if (CAMPOS_MONETARIOS.has(campo)) return new Decimal(a).eq(new Decimal(b));
  if (CAMPOS_DE_FECHA.has(campo)) return a === b;
  if (campo === 'fecha_de_pago' && a.includes('T') !== b.includes('T')) {
    // Una sola fecha sin hora: se compara el día argentino de la otra.
    const [dia, instante] = a.includes('T') ? [b, a] : [a, b];
    const fecha = new Date(instante);
    return !Number.isNaN(fecha.getTime()) && diaArgentino(fecha) === dia;
  }
  if (campo === 'fecha_de_pago' && a.includes('T')) {
    const fechaA = new Date(a);
    const fechaB = new Date(b);
    if (!Number.isNaN(fechaA.getTime()) && !Number.isNaN(fechaB.getTime())) {
      return fechaA.getTime() === fechaB.getTime();
    }
  }
  return a === b;
}

function diaArgentino(fecha: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(fecha);
}
