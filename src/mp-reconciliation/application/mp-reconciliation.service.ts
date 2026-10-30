import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource, EntityManager } from 'typeorm';
import { AttachmentService } from '../../attachment/attachment.service';
import { AttachmentOwnerType } from '../../attachment/entities/attachment.entity';
import { CashCollectionSettings } from '../../cash/entities/cash-collection-settings.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';
import { aCentavos } from '../../common/utils/dinero';
import {
  diaArgentino,
  diasEntre,
  rangoDeDiasArgentinos,
} from '../../common/utils/dias-argentina';
import { S3CleanupService } from '../../s3/s3-cleanup.service';
import { S3Service, SignedDownload } from '../../s3/s3.service';
import {
  MpItemStatus,
  MpReconciliationStatus,
} from '../domain/mp-reconciliation.enums';
import {
  MercadoPagoReportsPort,
  MpReportRef,
  MpReportsError,
} from '../domain/mp-reports.port';
import {
  conciliar,
  DiferenciaBorrador,
  PagoDelLibro,
} from '../domain/reconciliation';
import {
  armarCsvFiltrado,
  parsearReporteDeLiberaciones,
  ParsedReleaseReport,
  ReleaseReportFormatError,
  ReleaseRow,
} from '../domain/release-report.parser';
import {
  CreateMpReconciliationDto,
  MAX_DIAS_DE_CONCILIACION,
  QueryMpReconciliationDto,
} from '../dto/mp-reconciliation.dto';
import { MpReconciliationItem } from '../entities/mp-reconciliation-item.entity';
import {
  MpReconciliation,
  MpReconciliationSummary,
} from '../entities/mp-reconciliation.entity';
import { MpLedgerReader } from './mp-ledger.reader';
import { mensajeSeguro } from './mensaje-seguro';

/** Quién pide: la distribuidora efectiva y el rol (el super admin ve además lo de la cuenta). */
export interface MpContexto {
  distributorId: string;
  userId: string;
  role: RoleType;
}

/** Si Mercado Pago no genera el reporte en este tiempo, la corrida se da por fallida. */
const ESPERA_MAXIMA_MS = 24 * 60 * 60_000;
/** No se vuelve a preguntar a Mercado Pago más seguido que esto por la misma corrida. */
const ESPERA_ENTRE_CONSULTAS_MS = 20_000;
/** Holgura al comparar las fechas del reporte con las pedidas. */
const HOLGURA_FECHAS_MS = 60 * 60_000;

const aNumero = (d: Decimal): number => aCentavos(d);

interface Calculo {
  propios: Map<string, PagoDelLibro>;
  visibles: DiferenciaBorrador[];
  summary: MpReconciliationSummary;
}

/**
 * Conciliación de la caja de Mercado Pago contra el reporte de liberaciones.
 * Pide el reporte, espera a que esté, lo compara con el libro y guarda las
 * diferencias. La cuenta de Mercado Pago es una sola para todo el sistema: cada
 * distribuidora ve sólo los cobros suyos; lo que no es de ninguna (retiros,
 * impuestos sueltos, cobros desconocidos) lo ve únicamente el super admin.
 */
@Injectable()
export class MpReconciliationService {
  private readonly logger = new Logger(MpReconciliationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly reportes: MercadoPagoReportsPort,
    private readonly libro: MpLedgerReader,
    private readonly adjuntos: AttachmentService,
    private readonly storage: S3Service,
    private readonly cleanup: S3CleanupService,
  ) {}

  async crear(
    dto: CreateMpReconciliationDto,
    ctx: MpContexto,
  ): Promise<MpReconciliation> {
    const dias = this.validarRango(dto.from, dto.to);
    const rango = rangoDeDiasArgentinos(dto.from, dto.to);
    if (!rango) throw new BadRequestException('Fechas inválidas');
    const repetida = await this.dataSource.manager.exists(MpReconciliation, {
      where: {
        distributorId: ctx.distributorId,
        fromDate: dto.from,
        toDate: dto.to,
        status: MpReconciliationStatus.REQUESTED,
      },
    });
    if (repetida) {
      throw new ConflictException(
        'Ya hay una conciliación pedida para ese rango esperando el reporte de Mercado Pago',
      );
    }
    this.logger.log(
      `Conciliación Mercado Pago ${dto.from}..${dto.to} (${dias} días) pedida por ${ctx.userId}`,
    );
    const corrida = await this.dataSource.manager.save(
      this.dataSource.manager.create(MpReconciliation, {
        distributorId: ctx.distributorId,
        requestedByUserId: ctx.userId,
        fromDate: dto.from,
        toDate: dto.to,
        status: MpReconciliationStatus.REQUESTED,
        includeAccountLevel: ctx.role === RoleType.SUPER_ADMIN,
      }),
    );
    try {
      const pedido = {
        from: rango.desde,
        to: new Date(rango.hasta.getTime() - 1000),
      };
      const respuesta = await this.reportes.requestReport(pedido);
      corrida.mpReportId = respuesta.reportId;
      const distinto = (a: Date | null, b: Date): boolean =>
        a !== null && Math.abs(a.getTime() - b.getTime()) > HOLGURA_FECHAS_MS;
      if (
        distinto(respuesta.beginDate, pedido.from) ||
        distinto(respuesta.endDate, pedido.to)
      ) {
        throw new MpReportsError(
          'rejected',
          `Mercado Pago armó el reporte para otro rango (${respuesta.beginDate?.toISOString() ?? '?'} a ${respuesta.endDate?.toISOString() ?? '?'}): no se concilia`,
        );
      }
      return await this.dataSource.manager.save(corrida);
    } catch (error) {
      if (!(error instanceof MpReportsError)) throw error;
      corrida.status = MpReconciliationStatus.FAILED;
      corrida.failureReason = error.message.slice(0, 500);
      await this.dataSource.manager.save(corrida);
      throw this.aExcepcion(error);
    }
  }

  async listar(
    ctx: MpContexto,
    query: QueryMpReconciliationDto,
  ): Promise<{ data: MpReconciliation[]; total: number }> {
    const limit = query.limit ?? 10;
    const [data, total] = await this.dataSource.manager.findAndCount(
      MpReconciliation,
      {
        where: {
          distributorId: ctx.distributorId,
          ...(query.status ? { status: query.status } : {}),
        },
        order: { createdAt: 'DESC' },
        skip: ((query.page ?? 1) - 1) * limit,
        take: limit,
      },
    );
    return { data, total };
  }

  /** La corrida con sus diferencias; si todavía espera el reporte, antes le pregunta a Mercado Pago. */
  async detalle(
    id: string,
    ctx: MpContexto,
  ): Promise<{ corrida: MpReconciliation; items: MpReconciliationItem[] }> {
    let corrida = await this.buscar(id, ctx.distributorId);
    if (
      corrida.status === MpReconciliationStatus.REQUESTED &&
      (!corrida.lastCheckedAt ||
        Date.now() - corrida.lastCheckedAt.getTime() >=
          ESPERA_ENTRE_CONSULTAS_MS)
    ) {
      await this.sincronizar(id);
      corrida = await this.buscar(id, ctx.distributorId);
    }
    const items = await this.dataSource.manager.find(MpReconciliationItem, {
      where: {
        reconciliationId: id,
        distributorId: ctx.distributorId,
        ...(ctx.role === RoleType.SUPER_ADMIN ? {} : { accountLevel: false }),
      },
      order: { occurredAt: 'ASC', createdAt: 'ASC' },
    });
    return { corrida, items };
  }

  async buscar(id: string, distributorId: string): Promise<MpReconciliation> {
    const corrida = await this.dataSource.manager.findOne(MpReconciliation, {
      where: { reconciliationId: id, distributorId },
    });
    if (!corrida) {
      throw new NotFoundException(`Conciliación ${id} no encontrada`);
    }
    return corrida;
  }

  /** Enlace firmado al reporte: el completo para el super admin, el filtrado a la distribuidora para el resto. */
  async enlaceDelReporte(id: string, ctx: MpContexto): Promise<SignedDownload> {
    const corrida = await this.buscar(id, ctx.distributorId);
    if (
      ctx.role === RoleType.SUPER_ADMIN &&
      corrida.includeAccountLevel &&
      corrida.accountReportKey
    ) {
      return this.storage.getSignedDownload(corrida.accountReportKey, {
        fileName: `mercadopago-liberaciones-${corrida.fromDate}-${corrida.toDate}.csv`,
        contentType: 'text/csv',
      });
    }
    if (!corrida.reportAttachmentId) {
      throw new NotFoundException(
        'La conciliación todavía no tiene el reporte guardado',
      );
    }
    return this.adjuntos.getSignedDownload(
      corrida.reportAttachmentId,
      ctx.distributorId,
      { userId: ctx.userId, role: ctx.role },
    );
  }

  /** Corridas que esperan el reporte, las más viejas primero. */
  idsPendientes(limite = 20): Promise<string[]> {
    return this.dataSource.manager
      .find(MpReconciliation, {
        select: { reconciliationId: true },
        where: { status: MpReconciliationStatus.REQUESTED },
        order: { createdAt: 'ASC' },
        take: limite,
      })
      .then((filas) => filas.map((f) => f.reconciliationId));
  }

  /**
   * Pregunta a Mercado Pago por el reporte de una corrida pendiente y, si está,
   * lo concilia. La consulta, la descarga, el parseo y la subida a S3 van FUERA de
   * toda transacción; sólo guardar el resultado abre una (con la corrida bloqueada).
   * Un error pasajero (timeout, 5xx, límite de consultas) la deja pendiente; una falla
   * de credencial o de formato la da por fallida. Segura para correr en paralelo:
   * una consulta por corrida cada 15 segundos.
   */
  async sincronizar(id: string): Promise<void> {
    const corrida = await this.reclamar(id);
    if (!corrida) return;
    if (Date.now() - corrida.createdAt.getTime() > ESPERA_MAXIMA_MS) {
      const ultimo = corrida.failureReason
        ? ` (último intento: ${corrida.failureReason})`
        : '';
      await this.fallar(
        id,
        `Mercado Pago no generó el reporte en 24 horas${ultimo}: pedí la conciliación de nuevo`,
      );
      return;
    }
    try {
      await this.procesar(corrida);
    } catch (error) {
      if (error instanceof MpReportsError) {
        await this.manejarErrorDeMp(id, error);
      } else if (error instanceof ReleaseReportFormatError) {
        await this.fallar(id, error.message);
      } else {
        this.logger.error(
          `Conciliación ${id}: no se pudo procesar el reporte: ${errorMessage(error)}`,
        );
        await this.anotar(
          id,
          `No se pudo procesar el reporte: ${mensajeSeguro(error)}. Se reintenta.`,
        );
      }
    }
  }

  /** Toma la corrida para consultarla (una vez cada 15 s); `null` si no está pendiente o la tomó otro. */
  private async reclamar(id: string): Promise<MpReconciliation | null> {
    const resultado: unknown = await this.dataSource.manager.query(
      `UPDATE "mp_reconciliation" SET "last_checked_at" = now()
       WHERE "reconciliation_id" = $1 AND "status" = 'requested'
         AND ("last_checked_at" IS NULL OR "last_checked_at" < now() - interval '15 seconds')
       RETURNING "reconciliation_id"`,
      [id],
    );
    const filas =
      Array.isArray(resultado) && Array.isArray(resultado[0])
        ? resultado[0]
        : resultado;
    if (!Array.isArray(filas) || filas.length === 0) return null;
    return this.dataSource.manager.findOne(MpReconciliation, {
      where: { reconciliationId: id },
    });
  }

  private async procesar(corrida: MpReconciliation): Promise<void> {
    const referencia = this.elegirReporte(
      corrida,
      await this.reportes.listReports(),
    );
    if (!referencia || referencia.status === 'pending') {
      await this.anotar(corrida.reconciliationId, null);
      return;
    }
    if (referencia.status === 'failed' || !referencia.fileName) {
      await this.fallar(
        corrida.reconciliationId,
        'Mercado Pago no pudo generar el reporte: pedí la conciliación de nuevo',
      );
      return;
    }
    const csv = await this.reportes.downloadReport(referencia.fileName);
    const parseado = parsearReporteDeLiberaciones(csv);
    const calculo = await this.calcular(corrida, parseado);
    await this.guardarReporte(corrida, parseado, csv, calculo.propios);
    await this.confirmar(corrida, referencia, calculo);
  }

  /** El reporte que corresponde a la corrida: por id si Mercado Pago lo informó, si no por fechas. */
  private elegirReporte(
    corrida: MpReconciliation,
    lista: MpReportRef[],
  ): MpReportRef | null {
    if (corrida.mpReportId) {
      const porId = lista.find((r) => r.id === corrida.mpReportId);
      if (porId) return porId;
    }
    const rango = rangoDeDiasArgentinos(corrida.fromDate, corrida.toDate);
    if (!rango) return null;
    const pedidoDesde = corrida.createdAt.getTime() - HOLGURA_FECHAS_MS;
    return (
      lista
        .filter(
          (r) =>
            r.beginDate &&
            r.endDate &&
            Math.abs(r.beginDate.getTime() - rango.desde.getTime()) <=
              HOLGURA_FECHAS_MS &&
            Math.abs(r.endDate.getTime() - (rango.hasta.getTime() - 1000)) <=
              HOLGURA_FECHAS_MS &&
            (!r.generationDate || r.generationDate.getTime() >= pedidoDesde),
        )
        .sort(
          (a, b) =>
            (b.generationDate?.getTime() ?? 0) -
            (a.generationDate?.getTime() ?? 0),
        )[0] ?? null
    );
  }

  private async manejarErrorDeMp(
    id: string,
    error: MpReportsError,
  ): Promise<void> {
    const pasajero =
      error.kind === 'timeout' ||
      error.kind === 'unavailable' ||
      error.kind === 'rate_limited';
    if (pasajero) {
      this.logger.warn(`Conciliación ${id}: ${error.message}; se reintenta`);
      await this.anotar(id, `${error.message}. Se reintenta.`);
      return;
    }
    await this.fallar(id, error.message);
  }

  /** Deja anotado (o borra) el último motivo por el que sigue pendiente. */
  private async anotar(id: string, motivo: string | null): Promise<void> {
    await this.dataSource.manager.update(
      MpReconciliation,
      { reconciliationId: id, status: MpReconciliationStatus.REQUESTED },
      { failureReason: motivo ? motivo.slice(0, 500) : null },
    );
  }

  private async fallar(id: string, motivo: string): Promise<void> {
    await this.dataSource.manager.update(
      MpReconciliation,
      { reconciliationId: id, status: MpReconciliationStatus.REQUESTED },
      {
        status: MpReconciliationStatus.FAILED,
        failureReason: motivo.slice(0, 500),
      },
    );
  }

  /** Compara el reporte con el libro (sólo lectura, fuera de toda transacción). */
  private async calcular(
    corrida: MpReconciliation,
    parseado: ParsedReleaseReport,
  ): Promise<Calculo> {
    const rango = rangoDeDiasArgentinos(corrida.fromDate, corrida.toDate);
    if (!rango) throw new Error('Rango de la corrida inválido');
    const manager = this.dataSource.manager;
    const { distributorId } = corrida;
    const ids = [
      ...new Set(
        parseado.rows
          .filter((f) =>
            ['payment', 'refund', 'chargeback'].includes(f.description),
          )
          .map((f) => f.sourceId)
          .filter((s) => s !== ''),
      ),
    ];
    const { propios, ajenos, sinDistribuidora } =
      await this.libro.pagosDeLosIds(manager, distributorId, ids);
    const ingresosDelRango = await this.libro.ingresosDelRango(
      manager,
      distributorId,
      rango.desde,
      rango.hasta,
    );
    const aplicadas = await this.clavesAplicadas(manager, distributorId);
    const resultado = conciliar({
      filas: parseado.rows,
      propios,
      ajenos,
      sinDistribuidora,
      aplicadas,
      ingresosDelRango,
    });
    const visibles = resultado.diferencias.filter(
      (d) => corrida.includeAccountLevel || !d.accountLevel,
    );
    const summary = await this.resumen(
      manager,
      corrida,
      parseado,
      propios,
      visibles,
      resultado.yaAsentadas +
        (corrida.includeAccountLevel ? resultado.yaAsentadasDeCuenta : 0),
      rango,
    );
    return { propios, visibles, summary };
  }

  /** Guarda lo calculado y deja la corrida lista; lo único que corre dentro de la transacción. */
  private async confirmar(
    corrida: MpReconciliation,
    referencia: MpReportRef,
    calculo: Calculo,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const actual = await manager
        .createQueryBuilder(MpReconciliation, 'c')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('c.reconciliationId = :id', { id: corrida.reconciliationId })
        .getOne();
      if (!actual || actual.status !== MpReconciliationStatus.REQUESTED) return;
      if (calculo.visibles.length > 0) {
        await manager.insert(
          MpReconciliationItem,
          calculo.visibles.map((d) => ({
            reconciliationId: actual.reconciliationId,
            distributorId: actual.distributorId,
            rowKey: d.rowKey,
            kind: d.kind,
            accountLevel: d.accountLevel,
            sourceId: d.sourceId,
            paymentId: d.paymentId,
            orderId: d.orderId,
            occurredAt: d.occurredAt,
            mpDescription: d.mpDescription.slice(0, 120),
            mpAmount: d.mpAmount ? aNumero(d.mpAmount) : null,
            ledgerAmount: d.ledgerAmount ? aNumero(d.ledgerAmount) : null,
            difference: d.difference ? aNumero(d.difference) : null,
            extraAmount: d.extraAmount ? aNumero(d.extraAmount) : null,
            direction: d.direction,
            appliable: d.appliable,
            needsCashBox: d.needsCashBox,
            note: d.note.slice(0, 500),
            status: MpItemStatus.PENDING,
          })),
        );
      }
      actual.mpReportId = referencia.id ?? actual.mpReportId;
      actual.fileName = referencia.fileName;
      actual.summary = calculo.summary;
      actual.failureReason = null;
      actual.status = MpReconciliationStatus.READY;
      actual.readyAt = new Date();
      await manager.save(actual);
    });
  }

  /** Las filas ya asentadas de la distribuidora y las de la cuenta asentadas en cualquier distribuidora. */
  private async clavesAplicadas(
    manager: EntityManager,
    distributorId: string,
  ): Promise<Set<string>> {
    const filas: Array<{ row_key: string }> = await manager.query(
      `SELECT "row_key" FROM "mp_reconciliation_item"
       WHERE "status" = 'applied' AND ("distributor_id" = $1 OR "account_level" = true)`,
      [distributorId],
    );
    return new Set(filas.map((f) => f.row_key));
  }

  private async resumen(
    manager: EntityManager,
    corrida: MpReconciliation,
    parseado: ParsedReleaseReport,
    propios: ReadonlyMap<string, PagoDelLibro>,
    visibles: DiferenciaBorrador[],
    yaAsentadas: number,
    rango: { desde: Date; hasta: Date },
  ): Promise<MpReconciliationSummary> {
    const esDeLaDistribuidora = (f: ReleaseRow): boolean =>
      ['payment', 'refund', 'chargeback'].includes(f.description) &&
      propios.has(f.sourceId);
    const propias = parseado.rows.filter(esDeLaDistribuidora);
    const suma = (
      filas: ReleaseRow[],
      campo: (f: ReleaseRow) => Decimal,
    ): Decimal => filas.reduce((a, f) => a.plus(campo(f)), new Decimal(0));
    const cobros = propias.filter((f) => f.description === 'payment');
    const config = await manager.findOne(CashCollectionSettings, {
      where: { distributorId: corrida.distributorId },
    });
    const caja = config?.mercadoPagoCashBoxId
      ? await this.libro.movimientosDeLaCaja(
          manager,
          corrida.distributorId,
          config.mercadoPagoCashBoxId,
          rango.desde,
          rango.hasta,
        )
      : { income: new Decimal(0), expense: new Decimal(0) };
    const porTipo: Record<string, number> = {};
    for (const d of visibles) porTipo[d.kind] = (porTipo[d.kind] ?? 0) + 1;
    const resumen: MpReconciliationSummary = {
      rows: propias.length,
      mp: {
        gross: aNumero(suma(cobros, (f) => f.gross)),
        fees: aNumero(
          suma(cobros, (f) => f.mpFee.abs().plus(f.financingFee.abs())),
        ),
        taxes: aNumero(suma(cobros, (f) => f.taxes.abs())),
        net: aNumero(
          suma(propias, (f) => f.netCredit).minus(
            suma(propias, (f) => f.netDebit),
          ),
        ),
      },
      cash: {
        income: aNumero(caja.income),
        expense: aNumero(caja.expense),
        net: aNumero(caja.income.minus(caja.expense)),
      },
      differences: porTipo,
      alreadyApplied: yaAsentadas,
      unreadableRows: corrida.includeAccountLevel
        ? parseado.unreadable.length
        : 0,
    };
    if (corrida.includeAccountLevel) {
      const deCuenta = parseado.rows.filter(
        (f) => !esDeLaDistribuidora(f) && !propios.has(f.sourceId),
      );
      resumen.account = {
        rows: deCuenta.length,
        credit: aNumero(suma(deCuenta, (f) => f.netCredit)),
        debit: aNumero(suma(deCuenta, (f) => f.netDebit)),
      };
    }
    return resumen;
  }

  /**
   * Guarda el reporte UNA sola vez, después de procesarlo bien: el de la distribuidora como
   * adjunto y, si lo pidió un super admin, el completo en S3. Lo subido queda anotado en la
   * corrida enseguida, así un reintento no lo vuelve a subir.
   */
  private async guardarReporte(
    corrida: MpReconciliation,
    parseado: ParsedReleaseReport,
    csv: string,
    propios: ReadonlyMap<string, PagoDelLibro>,
  ): Promise<void> {
    if (!corrida.reportAttachmentId) {
      const filtrado = armarCsvFiltrado(
        parseado.headerLine,
        parseado.rows.filter(
          (f) =>
            ['payment', 'refund', 'chargeback'].includes(f.description) &&
            propios.has(f.sourceId),
        ),
      );
      const buffer = Buffer.from(filtrado, 'utf8');
      const adjunto = await this.adjuntos.upload(
        AttachmentOwnerType.MP_RECONCILIATION,
        corrida.reconciliationId,
        corrida.distributorId,
        {
          originalname: `mercadopago-liberaciones-${corrida.fromDate}-${corrida.toDate}.csv`,
          mimetype: 'text/csv',
          buffer,
          size: buffer.length,
        } as Express.Multer.File,
        'Reporte de liberaciones de Mercado Pago',
        { userId: corrida.requestedByUserId, role: RoleType.ADMIN },
      );
      corrida.reportAttachmentId = adjunto.attachmentId;
      await this.dataSource.manager.update(
        MpReconciliation,
        { reconciliationId: corrida.reconciliationId },
        { reportAttachmentId: adjunto.attachmentId },
      );
    }
    if (corrida.includeAccountLevel && !corrida.accountReportKey) {
      const key = `mp-reconciliations/${corrida.distributorId}/${corrida.reconciliationId}/${randomUUID()}.csv`;
      await this.cleanup.reserveUpload(key);
      await this.storage.put({
        key,
        body: Buffer.from(csv, 'utf8'),
        contentType: 'text/csv',
      });
      corrida.accountReportKey = key;
      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          MpReconciliation,
          { reconciliationId: corrida.reconciliationId },
          { accountReportKey: key },
        );
        await this.cleanup.confirmUpload(manager, key);
      });
    }
  }

  private validarRango(from: string, to: string): number {
    const dias = diasEntre(from, to) + 1;
    if (dias < 1) {
      throw new BadRequestException('`to` no puede ser anterior a `from`');
    }
    if (dias > MAX_DIAS_DE_CONCILIACION) {
      throw new BadRequestException(
        `El rango no puede pasar de ${MAX_DIAS_DE_CONCILIACION} días`,
      );
    }
    if (to > diaArgentino()) {
      throw new BadRequestException('`to` no puede ser una fecha futura');
    }
    return dias;
  }

  private aExcepcion(error: MpReportsError): Error {
    switch (error.kind) {
      case 'rejected':
        return new BadRequestException(error.message);
      case 'timeout':
        return new GatewayTimeoutException(error.message);
      case 'not_configured':
        return new ServiceUnavailableException(error.message);
      default:
        return new BadGatewayException(error.message);
    }
  }
}
