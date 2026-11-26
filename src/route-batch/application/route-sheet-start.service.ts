import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { DeliveryService } from '../../delivery/delivery.service';
import { FleetDispatchLockService } from '../../fleet/fleet-dispatch-lock.service';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import {
  CargaAbiertaDelChofer,
  TruckLoadLookupService,
} from '../../truck-load/application/truck-load-lookup.service';
import { TruckLoadStatus } from '../../truck-load/domain/truck-load.enums';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import {
  Faltante,
  faltantesDeCarga,
  motivoParaNoIniciar,
} from '../domain/route-sheet-execution';
import { assertTransition } from '../domain/route-sheet.machine';
import { RouteSheetAssignmentService } from './route-sheet-assignment.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import {
  CalculoEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  cargaEnOtroVehiculo,
  cargaExigida,
  cargaNoLista,
  choferNoHabilitado,
  faltaStock,
  hojaNoEncontrada,
  hojaNoEsDeHoy,
  hojaNoIniciable,
  nadaParaIniciar,
  vehiculoNoEnUso,
} from './route-sheet.exceptions';

/** Quién inicia: el chofer de la hoja o un administrador en su nombre. */
export interface QuienInicia {
  userId: string;
  esChofer: boolean;
}

export interface ResultadoDeInicio {
  sheetId: string;
  /** El viaje ya había empezado (reintento): no se hizo nada. */
  alreadyStarted: boolean;
  /** Los pedidos del viaje (asignados al chofer). */
  assignedOrderIds: string[];
  /** Pedidos que ya no estaban disponibles y salieron de la hoja. */
  droppedOrderIds: string[];
  /** Faltantes de la carga aceptados con `acknowledgeShortages` (D-04). */
  shortages: Faltante[];
  truckLoadId: string | null;
  /** Clientes a los que se les avisó que su pedido salió (push con la franja estimada). */
  notifiedCustomers: number;
}

/**
 * «Iniciar viaje» (§8.1, rediseño del 14/11; `confirmed → assigned`): la hoja
 * confirmada ya es del chofer y sus pedidos ya son suyos (se asignan el día
 * del reparto; si todavía no, se asignan acá). El chofer espera la carga del
 * camión: la carga (truck-loads) mueve las garrafas del depósito al vehículo al
 * confirmar su salida. Con la carga en la calle, el chofer (o un admin en su
 * nombre) inicia el viaje: hoja confirmada y de hoy, el vehículo de la hoja en
 * uso, chofer habilitado, la carga obligatoria en ese vehículo y ya salida, y
 * completa (o el faltante aceptado). Se les avisa a todos los clientes de la
 * hoja, por push, que su pedido está en camino con la franja estimada.
 *
 * Todo con el cerrojo de la hoja: dos inicios a la vez se serializan y el
 * segundo ve el viaje iniciado (respuesta idempotente).
 */
@Injectable()
export class RouteSheetStartService {
  private readonly logger = new Logger(RouteSheetStartService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RouteBatch)
    private readonly sheets: Repository<RouteBatch>,
    private readonly locks: RouteSheetLocks,
    private readonly progress: RouteSheetProgress,
    private readonly writer: RouteSheetWriter,
    private readonly asignacion: RouteSheetAssignmentService,
    private readonly deliveries: DeliveryService,
    private readonly fleet: FleetDispatchLockService,
    private readonly cargas: TruckLoadLookupService,
    private readonly eta: RouteSheetEtaService,
    private readonly notifier: RouteSheetNotifier,
  ) {}

  async iniciar(
    distributorId: string,
    id: string,
    quien: QuienInicia,
    acknowledgeShortages: boolean,
  ): Promise<ResultadoDeInicio> {
    const actor = quien.esChofer
      ? await this.choferDelUsuario(quien.userId, distributorId)
      : null;
    const inicial = await this.hoja(distributorId, id);
    // Lo ajeno no se distingue de lo inexistente: otra hoja del chofer es 404.
    if (actor && inicial.deliveryId !== actor.deliveryId) {
      throw hojaNoEncontrada();
    }
    return this.locks.conCerrojo([id], () =>
      this.iniciarConCerrojo(
        distributorId,
        id,
        actor,
        quien,
        acknowledgeShortages,
      ),
    );
  }

  private async iniciarConCerrojo(
    distributorId: string,
    id: string,
    actor: Delivery | null,
    quien: QuienInicia,
    acknowledgeShortages: boolean,
  ): Promise<ResultadoDeInicio> {
    // Aunque el cerrojo Redis se renueva, la fila es la autoridad final: se
    // relee con FOR UPDATE para que un reintento posterior a un inicio ya
    // confirmado responda idempotentemente y nunca intente otra transición.
    const inicio = await this.locks.enTransaccion<
      { resultado: ResultadoDeInicio } | { sheet: RouteBatch }
    >(distributorId, [{ id }], async (manager, [fila]) =>
      fila.status === RouteBatchStatus.ASSIGNED
        ? { resultado: await this.yaIniciada(fila, manager) }
        : { sheet: fila },
    );
    if ('resultado' in inicio) return inicio.resultado;
    const sheet = inicio.sheet;
    const motivo = motivoParaNoIniciar({
      status: sheet.status,
      planDate: sheet.planDate as string,
      hoy: diaArgentino(),
      sheetDeliveryId: sheet.deliveryId,
      actorDeliveryId: actor?.deliveryId ?? null,
    });
    if (motivo === 'wrong_driver') throw hojaNoEncontrada();
    if (motivo === 'not_confirmed') throw hojaNoIniciable();
    if (motivo === 'not_today') throw hojaNoEsDeHoy(sheet.planDate as string);

    const chofer =
      actor ??
      (sheet.deliveryId
        ? await this.deliveries.findById(sheet.deliveryId)
        : null);
    if (!chofer) throw hojaNoIniciable();
    await this.assertChoferListo(distributorId, sheet, chofer);
    const carga = await this.assertCarga(distributorId, sheet, chofer);

    // Los pedidos ya son del chofer (se asignaron al confirmar o al empezar el
    // día); si todavía no, se asignan ahora. Lo que ya no está libre sale.
    const asignacion = await this.asignacion.asignarConCerrojoTomado(
      distributorId,
      id,
      quien.userId,
    );
    const asignados = asignacion.assignedOrderIds;
    const caidos = asignacion.droppedOrderIds;
    if (asignados.length === 0) throw nadaParaIniciar();
    const shortages = await this.faltantes(sheet, carga);
    if (shortages.length > 0 && !acknowledgeShortages) {
      throw faltaStock(shortages);
    }

    const nowMs = Date.now();
    const posicion = await this.progress.posicionDelChofer(
      chofer.userId,
      nowMs,
    );
    const calculo = await this.locks.enTransaccion(
      distributorId,
      [{ id }],
      async (manager, [fila]): Promise<CalculoEnCurso | null> => {
        if (fila.status !== RouteBatchStatus.CONFIRMED) return null;
        assertTransition(fila.kind, fila.status, RouteBatchStatus.ASSIGNED);
        fila.status = RouteBatchStatus.ASSIGNED;
        fila.startedAt = new Date(nowMs);
        fila.truckLoadId = carga.loadId;
        await manager.save(fila);
        return this.progress.rehacer(manager, fila, {
          reordenar: false,
          nowMs,
          posicion,
        });
      },
    );
    if (!calculo) throw hojaNoIniciable();

    await this.eta.olvidarChofer(chofer.userId);
    const notifiedCustomers = await this.eta
      .avisarSalida(distributorId, id, calculo, nowMs, chofer.userId)
      .catch((e: unknown) => {
        this.logger.warn(`Hoja ${id}: avisos del inicio: ${errorMessage(e)}`);
        return 0;
      });
    this.notifier.alChofer(chofer.userId, 'route-sheet:started', {
      sheetId: id,
      orderIds: asignados,
      droppedOrderIds: caidos,
    });
    this.notifier.alPanel(distributorId, 'route-sheet:started', {
      sheetId: id,
      deliveryId: chofer.deliveryId,
      assignedOrders: asignados.length,
      droppedOrderIds: caidos,
    });
    this.notifier.hojaEnCurso(distributorId, id);
    this.logger.log(
      `Hoja ${id}: viaje iniciado con ${asignados.length} pedido(s), ${caidos.length} fuera, ${notifiedCustomers} cliente(s) avisado(s)`,
    );
    return {
      sheetId: id,
      alreadyStarted: false,
      assignedOrderIds: asignados,
      droppedOrderIds: caidos,
      shortages,
      truckLoadId: carga.loadId,
      notifiedCustomers,
    };
  }

  /** El reintento del inicio devuelve lo que ya está (idempotente). */
  private async yaIniciada(
    sheet: RouteBatch,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ResultadoDeInicio> {
    const activas = await this.writer.paradasActivas(
      manager,
      sheet.batchId,
      false,
    );
    return {
      sheetId: sheet.batchId,
      alreadyStarted: true,
      assignedOrderIds: activas.map((s) => s.orderId),
      droppedOrderIds: [],
      shortages: [],
      truckLoadId: sheet.truckLoadId,
      notifiedCustomers: 0,
    };
  }

  /** Vehículo de la hoja en uso y chofer habilitado hoy (los mismos gates de la asignación, antes de asignar nada). */
  private async assertChoferListo(
    distributorId: string,
    sheet: RouteBatch,
    chofer: Delivery,
  ): Promise<void> {
    const enUso = await this.fleet.vehiculoEnUsoDelChofer(
      chofer.userId,
      distributorId,
    );
    if (!enUso || enUso.carId !== sheet.carId) {
      throw vehiculoNoEnUso(
        await this.patente(sheet.carId),
        enUso?.patent ?? null,
      );
    }
    const motivos = await this.fleet.motivosDeInhabilitacion(
      chofer.userId,
      distributorId,
    );
    if (!chofer.isEnabled || !chofer.validated) {
      motivos.unshift('el chofer está deshabilitado o sin validar');
    }
    if (motivos.length > 0) throw choferNoHabilitado(motivos);
  }

  /** La carga abierta del chofer, obligatoria: en el vehículo de la hoja y ya salida del depósito. */
  private async assertCarga(
    distributorId: string,
    sheet: RouteBatch,
    chofer: Delivery,
  ): Promise<CargaAbiertaDelChofer> {
    const carga = await this.cargas.cargaAbiertaDelChofer(
      distributorId,
      chofer.deliveryId,
    );
    // El viaje de una hoja sale siempre con su carga: es la que movió las
    // garrafas del depósito al vehículo (exija o no la distribuidora la carga
    // para el despacho común).
    if (!carga) throw cargaExigida();
    if (carga.carId !== sheet.carId) {
      throw cargaEnOtroVehiculo(
        carga.number,
        carga.carPatent,
        await this.patente(sheet.carId),
      );
    }
    if (carga.status !== TruckLoadStatus.ON_ROUTE) {
      throw cargaNoLista(carga.number, carga.status);
    }
    return carga;
  }

  /** Llenas que pide la hoja contra las que tiene el camión (D-04). */
  private async faltantes(
    sheet: RouteBatch,
    carga: CargaAbiertaDelChofer,
  ): Promise<Faltante[]> {
    const filas: Array<{
      gasCylinderId: string;
      type: string | null;
      units: number;
    }> = await this.dataSource.query(
      `SELECT oi."gas_cylinder_id" AS "gasCylinderId", gc."type" AS "type", SUM(oi."quantity")::int AS "units"
         FROM "route_batch_stop" s
         JOIN "order_item" oi ON oi."order_id" = s."order_id"
         JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = oi."gas_cylinder_id"
        WHERE s."batch_id" = $1 AND s."active"
        GROUP BY oi."gas_cylinder_id", gc."type"
        ORDER BY gc."type", oi."gas_cylinder_id"`,
      [sheet.batchId],
    );
    return faltantesDeCarga(filas, carga.fullOnTruck);
  }

  private async hoja(distributorId: string, id: string): Promise<RouteBatch> {
    const sheet = await this.sheets.findOne({
      where: { batchId: id, distributorId, kind: RouteBatchKind.PLANNED },
    });
    if (!sheet) throw hojaNoEncontrada();
    return sheet;
  }

  private async choferDelUsuario(
    userId: string,
    distributorId: string,
  ): Promise<Delivery> {
    const d = await this.deliveries.findOneByUserId(userId).catch(() => null);
    if (!d || d.distributorId !== distributorId) throw hojaNoEncontrada();
    return d;
  }

  private async patente(carId: string | null): Promise<string | null> {
    if (!carId) return null;
    const [f] = await this.dataSource.query<Array<{ patent: string | null }>>(
      `SELECT "car_patent" AS "patent" FROM "car" WHERE "car_id" = $1`,
      [carId],
    );
    return f?.patent ?? null;
  }
}
