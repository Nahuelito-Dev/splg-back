import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { CarService } from '../car/car.service';
import { ProposalStatus } from '../common/enums/proposal-status.enum';
import { errorMessage } from '../common/errors/error-message';
import { ConfigurableProcess } from '../distributor/entities/module-config.entity';
import { ValoresDeProceso } from '../distributor/process-config';
import {
  ProcesoVigente,
  ProcessConfigService,
} from '../distributor/process-config.service';
import { DeliveryService } from '../delivery/delivery.service';
import { Delivery } from '../delivery/entities/delivery.entity';
import { FleetDispatchLockService } from '../fleet/fleet-dispatch-lock.service';
import { DispatchOrchestratorService } from '../order/application/dispatch-orchestrator.service';
import {
  RouteBatch,
  RouteBatchCloseReason,
  RouteBatchStatus,
} from '../order/entities/route-batch.entity';
import { RouteBatchOffer } from '../order/entities/route-batch-offer.entity';
import { RouteBatchStop } from '../order/entities/route-batch-stop.entity';
import { Order, OrderStatus } from '../order/entities/order.entity';
import { OrderService } from '../order/order.service';
import { RedisService } from '../redis/redis.service';
import {
  armarGrupo,
  CapacidadKg,
  DistanciaEntrePedidos,
  ordenarParadas,
  Parada,
  ParametrosDeAgrupacion,
  PedidoCandidato,
  pesoTotal,
} from './domain/route-planning';
import { RouteBatchNotifier } from './route-batch.notifier';

/** Un pedido candidato con su ubicación, para buscar choferes cerca. */
interface Candidato extends PedidoCandidato {
  lat: number;
  lng: number;
}

interface ChoferCandidato {
  userId: string;
  deliveryId: string;
  capacidadKg: CapacidadKg;
}

/** Cuántos pedidos quedaron sin lote, cada uno en un solo motivo (la suma es candidatos − pedidos en lotes). */
export interface MotivosDeNoArmado {
  noDriversNearby: number;
  driversNotEligible: number;
  notEnoughStops: number;
  lockConflict: number;
}

export interface ChoferNoElegible {
  driverName: string;
  reasons: string[];
}

export interface ResumenDeEvaluacion {
  candidates: number;
  batches: number;
  orders: number;
  reasons: MotivosDeNoArmado;
  driversNotEligibleDetail: ChoferNoElegible[];
}

/** Lo que se va anotando de por qué cada pedido quedó sin lote. */
interface Diagnostico {
  /** Sólo «Armar ahora» pide el detalle; el proceso periódico no paga las consultas. */
  activo: boolean;
  reasons: MotivosDeNoArmado;
  detalle: ChoferNoElegible[];
  /** `user_id` ya listados en el detalle, para no repetirlos entre semillas. */
  listados: Set<string>;
  /** Motivos ya calculados por `user_id`: un chofer se evalúa una vez por corrida. */
  motivosPorChofer: Map<string, string[]>;
}

export interface ResumenDeVencimientos {
  expired: number;
  rescued: number;
  completed: number;
}

export interface ResultadoDeDecision {
  batchId: string;
  accepted: boolean;
  assignedOrders: number;
}

const TOPE_DE_CANDIDATOS = 100;
const CHOFERES_A_PROBAR = 5;
const DETALLE_DE_CHOFERES = 5;
const MOTIVO_CON_LOTE = 'ya tiene un lote ofrecido o asignado';
const CERROJO_TTL_MS = 60_000;
const ESPERA_DEL_CERROJO_MS = 3_000;
/** Código de Postgres de una violación de índice único. */
const VIOLACION_DE_UNICO = '23505';

function claveDePar(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function esViolacionDeUnico(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === VIOLACION_DE_UNICO
  );
}

/**
 * Agrupación inteligente de pedidos por recorrido (CU-107, módulo inteligente
 * M4). Arma lotes de pedidos programados cercanos y de franjas compatibles,
 * los ordena en un recorrido y los ofrece completos, a un chofer por vez, con
 * vigencia. Aceptar asigna los pedidos en orden; rechazar o vencer pasa al
 * siguiente de inmediato; agotados los choferes, el lote se deshace y los
 * pedidos vuelven al despacho individual (M1).
 *
 * Convive con M1: un pedido de un lote vivo no se ofrece suelto
 * (`DispatchOrchestratorService` lo consulta) y M4 no toma los pedidos que M1
 * ya está ofreciendo. Cada paso que cambia un lote corre con el cerrojo del
 * lote en Redis y, dentro, con el lock de fila de la base; los índices únicos
 * (un pedido en un solo lote vivo, una oferta viva por lote) son la última red.
 */
@Injectable()
export class RouteBatchService {
  private readonly logger = new Logger(RouteBatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RouteBatch)
    private readonly batches: Repository<RouteBatch>,
    @InjectRepository(RouteBatchStop)
    private readonly stops: Repository<RouteBatchStop>,
    @InjectRepository(RouteBatchOffer)
    private readonly offers: Repository<RouteBatchOffer>,
    private readonly processConfig: ProcessConfigService,
    private readonly orchestrator: DispatchOrchestratorService,
    private readonly orderService: OrderService,
    private readonly deliveries: DeliveryService,
    private readonly fleet: FleetDispatchLockService,
    private readonly cars: CarService,
    private readonly redis: RedisService,
    private readonly notifier: RouteBatchNotifier,
  ) {}

  // ───────────────────────── parámetros ─────────────────────────

  /** Los parámetros vigentes de la agrupación de la distribuidora. */
  parametros(distributorId: string): Promise<ValoresDeProceso> {
    return this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_BATCHING,
    );
  }

  /** Los parámetros con su esquema, para la pantalla de configuración. */
  parametrosVigentes(distributorId: string): Promise<ProcesoVigente> {
    return this.processConfig.vigentes(
      distributorId,
      ConfigurableProcess.ROUTE_BATCHING,
    );
  }

  /** Cambia sólo los parámetros que vienen; los demás conservan su valor. */
  async cambiarParametros(
    distributorId: string,
    cambios: Record<string, number | undefined>,
    userId: string,
  ): Promise<ProcesoVigente> {
    const actuales = await this.parametros(distributorId);
    const nuevos: Record<string, number> = { ...actuales };
    for (const [clave, valor] of Object.entries(cambios)) {
      if (valor !== undefined) nuevos[clave] = valor;
    }
    return this.processConfig.guardar(
      distributorId,
      ConfigurableProcess.ROUTE_BATCHING,
      nuevos,
      userId,
    );
  }

  /** El interruptor del módulo: apagado por omisión, lo enciende el administrador. */
  async estaEncendido(distributorId: string): Promise<boolean> {
    return (await this.parametros(distributorId)).enabled === 1;
  }

  /** «Armar ahora»: igual que la pasada periódica, pero con el módulo apagado responde 409. */
  async armarAhora(distributorId: string): Promise<ResumenDeEvaluacion> {
    if (!(await this.estaEncendido(distributorId))) {
      throw new ConflictException(
        'La agrupación por recorrido está apagada: encendela en los parámetros para armar lotes',
      );
    }
    const resumen = await this.evaluar(distributorId, new Date(), true);
    if (!resumen) {
      throw new ConflictException(
        'Ya se están armando los lotes de esta distribuidora: reintentá en un momento',
      );
    }
    return resumen;
  }

  // ───────────────────────── armado (pasos 2 a 7) ─────────────────────────

  /** Las distribuidoras con pedidos programados sin chofer: las únicas que el proceso mira. */
  async distribuidorasConProgramados(): Promise<string[]> {
    const filas: Array<{ distributorId: string }> = await this.dataSource.query(
      `SELECT DISTINCT o."distributor_id" AS "distributorId"
         FROM "order" o
        WHERE o."status" = 'pending' AND o."delivery_id" IS NULL
          AND o."scheduled_date" IS NOT NULL AND o."time_slot_id" IS NOT NULL`,
    );
    return filas.map((f) => f.distributorId);
  }

  /**
   * Una pasada del proceso para una distribuidora: recupera los programados,
   * los agrupa, los ordena y ofrece cada lote al chofer más cercano. Idempotente:
   * un pedido que ya está en un lote vivo no vuelve a entrar en otro. Con el
   * cerrojo tomado por otra instancia no hace nada.
   */
  async evaluar(
    distributorId: string,
    ahora: Date = new Date(),
    conMotivos = false,
  ): Promise<ResumenDeEvaluacion | null> {
    const r = await this.redis.withLock(
      `route-batch:evaluar:${distributorId}`,
      CERROJO_TTL_MS,
      () => this.armarLotes(distributorId, ahora, conMotivos),
    );
    // `null`: otra instancia tiene el cerrojo y no se evaluó nada.
    return r.obtenido ? r.valor : null;
  }

  private async armarLotes(
    distributorId: string,
    ahora: Date,
    conMotivos: boolean,
  ): Promise<ResumenDeEvaluacion> {
    const params = this.agrupacion(await this.parametros(distributorId));
    const candidatos = await this.candidatos(distributorId, ahora);
    const diagnostico: Diagnostico = {
      activo: conMotivos,
      reasons: {
        noDriversNearby: 0,
        driversNotEligible: 0,
        notEnoughStops: 0,
        lockConflict: 0,
      },
      detalle: [],
      listados: new Set(),
      motivosPorChofer: new Map(),
    };
    const resumen: ResumenDeEvaluacion = {
      candidates: candidatos.length,
      batches: 0,
      orders: 0,
      reasons: diagnostico.reasons,
      driversNotEligibleDetail: diagnostico.detalle,
    };
    if (candidatos.length < 2) {
      if (candidatos.length === 1 && diagnostico.activo) {
        const ocupados = await this.choferesOcupados();
        await this.explicarSobrante(
          distributorId,
          candidatos[0],
          ocupados,
          diagnostico,
        );
      }
      return resumen;
    }

    const distancias = await this.distancias(candidatos.map((c) => c.orderId));
    const distancia: DistanciaEntrePedidos = (a, b) =>
      a === b ? 0 : (distancias.get(claveDePar(a, b)) ?? Infinity);
    const ocupados = await this.choferesOcupados();

    let pool = candidatos;
    while (pool.length >= 2) {
      const [semilla, ...resto] = pool;
      const usados = await this.intentarLote(
        distributorId,
        semilla,
        resto,
        params,
        distancia,
        ocupados,
        ahora,
        diagnostico,
      );
      if (usados) {
        resumen.batches += 1;
        resumen.orders += usados.size;
        pool = resto.filter((p) => !usados.has(p.orderId));
      } else {
        pool = resto;
      }
    }
    // El último pedido del pool no llega a ser semilla (no hay con quién agruparlo):
    // también se diagnostica, sin intentar un lote.
    if (pool.length === 1) {
      await this.explicarSobrante(
        distributorId,
        pool[0],
        ocupados,
        diagnostico,
      );
    }
    return resumen;
  }

  private agrupacion(valores: ValoresDeProceso): ParametrosDeAgrupacion & {
    offerTtlSeconds: number;
  } {
    return {
      maxBatchSize: valores.maxBatchSize,
      groupingRadiusKm: valores.groupingRadiusKm,
      slotToleranceMinutes: valores.slotToleranceMinutes,
      offerTtlSeconds: valores.offerTtlSeconds,
    };
  }

  /**
   * Paso 2: pedidos programados con la franja por delante, sin chofer, que M1
   * no está ofreciendo ahora y que no están ya en un lote vivo. Los de Mercado
   * Pago sin pagar no salen (igual que en el despacho individual). Tampoco vuelve
   * a entrar el pedido de un lote que se agotó o que deshizo un administrador:
   * espera a que lo tome M1 al entrar en su margen (si no, el mismo lote se
   * armaría cada minuto con los mismos choferes).
   */
  private async candidatos(
    distributorId: string,
    ahora: Date,
  ): Promise<Candidato[]> {
    const filas: Array<{
      orderId: string;
      slotStartMs: string;
      slotEndMs: string;
      lat: string;
      lng: string;
      createdAtMs: string;
      weightKg: string;
    }> = await this.dataSource.query(
      `SELECT o."order_id" AS "orderId",
              EXTRACT(EPOCH FROM ((o."scheduled_date" + ts."startTime") AT TIME ZONE 'America/Argentina/Buenos_Aires')) * 1000 AS "slotStartMs",
              EXTRACT(EPOCH FROM ((o."scheduled_date" + ts."endTime") AT TIME ZONE 'America/Argentina/Buenos_Aires')) * 1000 AS "slotEndMs",
              ST_Y(o."deliveryPoint") AS "lat",
              ST_X(o."deliveryPoint") AS "lng",
              EXTRACT(EPOCH FROM o."createdAt") * 1000 AS "createdAtMs",
              COALESCE((SELECT SUM(oi."quantity" * gc."weight")
                          FROM "order_item" oi
                          JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = oi."gas_cylinder_id"
                         WHERE oi."order_id" = o."order_id"), 0) AS "weightKg"
         FROM "order" o
         JOIN "time_slot" ts ON ts."time_slot_id" = o."time_slot_id"
        WHERE o."distributor_id" = $1
          AND o."status" = 'pending' AND o."delivery_id" IS NULL
          AND o."delivery_mode" = 'standard'
          AND o."scheduled_date" IS NOT NULL
          AND o."deliveryPoint" IS NOT NULL
          AND ((o."scheduled_date" + ts."endTime") AT TIME ZONE 'America/Argentina/Buenos_Aires') > $2
          AND NOT (o."paymentMethod" = 'mercadopago' AND o."paymentStatus" <> 'paid' AND NOT o."deposit_paid")
          AND NOT o."payment_fraud_hold"
          AND NOT EXISTS (SELECT 1 FROM "order_dispatch_offer" d
                           WHERE d."order_id" = o."order_id" AND d."status" = 'offered')
          AND NOT EXISTS (SELECT 1 FROM "route_batch_stop" s
                           WHERE s."order_id" = o."order_id" AND s."active")
          AND NOT EXISTS (SELECT 1 FROM "route_batch_stop" s
                            JOIN "route_batch" b ON b."batch_id" = s."batch_id"
                           WHERE s."order_id" = o."order_id" AND b."status" = 'dissolved'
                             AND b."kind" = 'offer'
                             AND b."close_reason" IN ('exhausted', 'admin'))
        ORDER BY 2, 6, 1
        LIMIT ${TOPE_DE_CANDIDATOS}`,
      [distributorId, ahora],
    );
    return filas.map((f) => ({
      orderId: f.orderId,
      slotStartMs: Number(f.slotStartMs),
      slotEndMs: Number(f.slotEndMs),
      lat: Number(f.lat),
      lng: Number(f.lng),
      createdAtMs: Number(f.createdAtMs),
      weightKg: Number(f.weightKg),
    }));
  }

  /** Paso 3: kilómetros entre cada par de pedidos, calculados por PostGIS sobre geography. */
  private async distancias(ids: string[]): Promise<Map<string, number>> {
    const filas: Array<{ a: string; b: string; km: string }> =
      await this.dataSource.query(
        `SELECT a."order_id" AS "a", b."order_id" AS "b",
                ST_Distance(a."deliveryPoint"::geography, b."deliveryPoint"::geography) / 1000 AS "km"
           FROM "order" a
           JOIN "order" b ON a."order_id" < b."order_id"
          WHERE a."order_id" = ANY($1::uuid[]) AND b."order_id" = ANY($1::uuid[])`,
        [ids],
      );
    return new Map(filas.map((f) => [claveDePar(f.a, f.b), Number(f.km)]));
  }

  /** Choferes con una oferta de lote sin responder o con un lote asignado en curso. */
  private async choferesOcupados(): Promise<Set<string>> {
    const filas: Array<{ deliveryId: string }> = await this.dataSource.query(
      `SELECT o."delivery_id" AS "deliveryId" FROM "route_batch_offer" o WHERE o."status" = 'pending'
       UNION
       SELECT b."delivery_id" FROM "route_batch" b WHERE b."status" = 'assigned' AND b."delivery_id" IS NOT NULL`,
    );
    return new Set(filas.map((f) => f.deliveryId));
  }

  /**
   * Paso 7: los choferes habilitados más cercanos al punto de partida del
   * recorrido (el mismo criterio de elegibilidad que el despacho individual),
   * sin los que ya están ocupados con otro lote ni los excluidos.
   */
  private async choferesCerca(
    distributorId: string,
    lat: number,
    lng: number,
    excluidos: ReadonlySet<string>,
  ): Promise<ChoferCandidato[]> {
    const userIds = await this.orchestrator.choferesElegiblesCerca(
      lat,
      lng,
      distributorId,
    );
    if (userIds.length === 0) return [];
    const filas = await this.deliveries.findDeliveryIdsByUserIds(
      userIds,
      distributorId,
    );
    const deliveryPorUsuario = new Map(filas.map((f) => [f.userId, f]));
    const resultado: ChoferCandidato[] = [];
    for (const userId of userIds) {
      const d = deliveryPorUsuario.get(userId);
      if (!d || excluidos.has(d.deliveryId)) continue;
      resultado.push({
        userId,
        deliveryId: d.deliveryId,
        capacidadKg: await this.capacidadDelChofer(userId, distributorId),
      });
      if (resultado.length >= CHOFERES_A_PROBAR) break;
    }
    return resultado;
  }

  /** Los kilos que carga el vehículo en uso del chofer; `null` si no tiene o no tiene capacidad cargada. */
  private async capacidadDelChofer(
    userId: string,
    distributorId: string,
  ): Promise<CapacidadKg> {
    const vehiculo = await this.fleet.vehiculoEnUsoDelChofer(
      userId,
      distributorId,
    );
    if (!vehiculo) return null;
    try {
      const car = await this.cars.findOne(vehiculo.carId, distributorId);
      return car.carCapacity === null || car.carCapacity === undefined
        ? null
        : Number(car.carCapacity);
    } catch {
      return null;
    }
  }

  /**
   * Pasos 3 a 7 para una semilla: prueba los choferes cercanos de a uno (cada
   * vehículo tiene su capacidad), arma el grupo que le cabe, lo ordena y, si
   * quedan al menos dos paradas, lo persiste y lo ofrece. Devuelve los pedidos
   * que quedaron en el lote, o `null` si no se pudo armar.
   */
  private async intentarLote(
    distributorId: string,
    semilla: Candidato,
    resto: Candidato[],
    params: ParametrosDeAgrupacion & { offerTtlSeconds: number },
    distancia: DistanciaEntrePedidos,
    ocupados: Set<string>,
    ahora: Date,
    diagnostico: Diagnostico,
  ): Promise<Set<string> | null> {
    const choferes = await this.choferesCerca(
      distributorId,
      semilla.lat,
      semilla.lng,
      ocupados,
    );
    if (choferes.length === 0) {
      if (diagnostico.activo) {
        await this.explicarSinChoferes(
          distributorId,
          semilla,
          ocupados,
          diagnostico,
        );
      }
      return null;
    }
    let conflicto = false;
    for (const chofer of choferes) {
      const grupo = armarGrupo(
        semilla,
        resto,
        params,
        distancia,
        chofer.capacidadKg,
      );
      if (grupo.length < 2) continue;
      const { paradas, excluidos } = ordenarParadas(grupo, distancia);
      if (paradas.length < 2) continue;
      const enElLote = grupo.filter((g) => !excluidos.includes(g.orderId));
      const creado = await this.crearLoteOfrecido(
        distributorId,
        enElLote,
        paradas,
        chofer,
        params.offerTtlSeconds,
        ahora,
      );
      if (creado) {
        ocupados.add(chofer.deliveryId);
        return new Set(enElLote.map((p) => p.orderId));
      }
      conflicto = true;
    }
    if (conflicto) diagnostico.reasons.lockConflict += 1;
    else diagnostico.reasons.notEnoughStops += 1;
    return null;
  }

  /**
   * Un pedido que quedó solo (el último del pool, o el único candidato): si hay
   * un chofer disponible el motivo es que no tiene con quién agruparse; si no,
   * el de los choferes. Sólo con el diagnóstico pedido y sin intentar un lote.
   */
  private async explicarSobrante(
    distributorId: string,
    pedido: Candidato,
    ocupados: Set<string>,
    diagnostico: Diagnostico,
  ): Promise<void> {
    if (!diagnostico.activo) return;
    try {
      const choferes = await this.choferesCerca(
        distributorId,
        pedido.lat,
        pedido.lng,
        ocupados,
      );
      if (choferes.length > 0) {
        diagnostico.reasons.notEnoughStops += 1;
        return;
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo diagnosticar el pedido ${pedido.orderId}: ${errorMessage(error)}`,
      );
      diagnostico.reasons.driversNotEligible += 1;
      return;
    }
    await this.explicarSinChoferes(
      distributorId,
      pedido,
      ocupados,
      diagnostico,
    );
  }

  /**
   * La semilla no tuvo a quién ofrecerle: distingue radar vacío de choferes que
   * están en el radar pero no pueden (flota, taller, laboral, carga, ocupados) y
   * anota los primeros con sus motivos. Sólo choferes de esta distribuidora. Si
   * el diagnóstico falla no frena el armado: se loguea y el pedido se cuenta
   * igual como «choferes que no pueden».
   */
  private async explicarSinChoferes(
    distributorId: string,
    semilla: Candidato,
    ocupados: ReadonlySet<string>,
    diagnostico: Diagnostico,
  ): Promise<void> {
    const faltan = DETALLE_DE_CHOFERES - diagnostico.detalle.length;
    let enRadar: Awaited<
      ReturnType<DispatchOrchestratorService['choferesCercaConMotivos']>
    >;
    try {
      enRadar = await this.orchestrator.choferesCercaConMotivos(
        semilla.lat,
        semilla.lng,
        distributorId,
        faltan > 0,
        diagnostico.motivosPorChofer,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo diagnosticar el pedido ${semilla.orderId}: ${errorMessage(error)}`,
      );
      diagnostico.reasons.driversNotEligible += 1;
      return;
    }
    if (enRadar.length === 0) {
      diagnostico.reasons.noDriversNearby += 1;
      return;
    }
    diagnostico.reasons.driversNotEligible += 1;
    for (const c of enRadar) {
      if (diagnostico.detalle.length >= DETALLE_DE_CHOFERES) break;
      const reasons = c.reasons.length
        ? c.reasons
        : ocupados.has(c.deliveryId)
          ? [MOTIVO_CON_LOTE]
          : [];
      if (reasons.length === 0 || diagnostico.listados.has(c.userId)) continue;
      let driverName = 'Chofer';
      try {
        const perfil = await this.deliveries.buscarPorIdOUsuario(
          c.userId,
          true,
        );
        driverName = perfil?.user?.fullName ?? driverName;
      } catch (error) {
        this.logger.warn(
          `No se pudo leer el nombre del chofer ${c.userId}: ${errorMessage(error)}`,
        );
      }
      diagnostico.listados.add(c.userId);
      diagnostico.detalle.push({ driverName, reasons });
    }
  }

  /**
   * Persiste el lote y su primera oferta en una transacción. Primero bloquea
   * los pedidos: si alguno ya no está pendiente y sin chofer, o M1 le abrió una
   * oferta, no se arma (devuelve `false` y el próximo ciclo lo reintenta).
   */
  private async crearLoteOfrecido(
    distributorId: string,
    pedidos: PedidoCandidato[],
    paradas: Parada[],
    chofer: ChoferCandidato,
    offerTtlSeconds: number,
    ahora: Date,
  ): Promise<boolean> {
    const ids = pedidos.map((p) => p.orderId);
    let creado: { batch: RouteBatch; offer: RouteBatchOffer } | null;
    try {
      // Mismo cerrojo por pedido que usa M1 para ofrecerlo: M1 revisa si está en
      // un lote vivo dentro de él, así que no puede ofrecerlo suelto mientras se arma.
      creado = await this.conCerrojosDePedidos([...ids].sort(), () =>
        this.dataSource.transaction(async (manager) => {
          const libres: Array<{ orderId: string }> = await manager.query(
            `SELECT o."order_id" AS "orderId" FROM "order" o
            WHERE o."order_id" = ANY($1::uuid[]) AND o."distributor_id" = $2
              AND o."status" = 'pending' AND o."delivery_id" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "order_dispatch_offer" d
                               WHERE d."order_id" = o."order_id" AND d."status" = 'offered')
            FOR UPDATE OF o`,
            [ids, distributorId],
          );
          if (libres.length !== ids.length) return null;

          const batch = await manager.save(
            manager.create(RouteBatch, {
              distributorId,
              status: RouteBatchStatus.OFFERED,
              totalWeightKg: pesoTotal(pedidos),
              deliveryId: null,
            }),
          );
          await manager.save(
            paradas.map((p) =>
              manager.create(RouteBatchStop, {
                batchId: batch.batchId,
                orderId: p.orderId,
                sequence: p.sequence,
                active: true,
                etaAt: new Date(p.etaMs),
                legDistanceKm: p.legDistanceKm,
              }),
            ),
          );
          const offer = await this.crearOferta(
            manager,
            batch.batchId,
            chofer.deliveryId,
            offerTtlSeconds,
            ahora,
          );
          return { batch, offer };
        }),
      );
    } catch (error) {
      // Un pedido entró a otro lote vivo entre la lectura y la escritura.
      if (esViolacionDeUnico(error)) return false;
      throw error;
    }
    if (!creado) return false;

    this.logger.log(
      `Lote ${creado.batch.batchId}: ${paradas.length} paradas, ${creado.batch.totalWeightKg} kg, ofrecido al chofer ${chofer.userId} (vence ${creado.offer.expiresAt.toISOString()})`,
    );
    await this.avisarOferta(chofer.deliveryId, creado.batch, creado.offer);
    return true;
  }

  /** Toma, de a uno y en orden, el cerrojo de oferta de cada pedido; si alguno está tomado, `null`. */
  private async conCerrojosDePedidos<T>(
    ids: string[],
    fn: () => Promise<T>,
  ): Promise<T | null> {
    if (ids.length === 0) return fn();
    const [primero, ...resto] = ids;
    const r = await this.redis.withLock(
      `dispatch:offer:${primero}`,
      CERROJO_TTL_MS,
      () => this.conCerrojosDePedidos(resto, fn),
      ESPERA_DEL_CERROJO_MS,
    );
    return r.obtenido ? r.valor : null;
  }

  private async crearOferta(
    manager: EntityManager,
    batchId: string,
    deliveryId: string,
    offerTtlSeconds: number,
    ahora: Date,
  ): Promise<RouteBatchOffer> {
    return manager.save(
      manager.create(RouteBatchOffer, {
        batchId,
        deliveryId,
        status: ProposalStatus.PENDING,
        expiresAt: new Date(ahora.getTime() + offerTtlSeconds * 1000),
        respondedAt: null,
      }),
    );
  }

  private async avisarOferta(
    deliveryId: string,
    batch: RouteBatch,
    offer: RouteBatchOffer,
  ): Promise<void> {
    try {
      const delivery = await this.deliveries.buscarPorIdOUsuario(deliveryId);
      if (!delivery) return;
      const stopCount = await this.stops.count({
        where: { batchId: batch.batchId, active: true },
      });
      await this.notifier.ofertaAlChofer(delivery, {
        batchId: batch.batchId,
        offerId: offer.offerId,
        expiresAt: offer.expiresAt,
        totalWeightKg: batch.totalWeightKg,
        stopCount,
      });
    } catch (error) {
      this.logger.warn(
        `Lote ${batch.batchId}: no se pudo avisar al chofer: ${errorMessage(error)}`,
      );
    }
  }

  // ───────────────────────── respuestas (pasos 8 a 11) ─────────────────────────

  /**
   * Paso 8: el chofer acepta dentro de la vigencia. Se le asignan los pedidos
   * del lote en el orden del recorrido, cada uno por el mismo camino que la
   * asignación individual (con sus gates de flota y de carga). Un pedido que se
   * canceló o se asignó aparte mientras tanto sale del lote y no frena a los
   * demás; si ninguno se puede asignar, el lote se deshace.
   */
  async aceptar(userId: string, batchId: string): Promise<ResultadoDeDecision> {
    const delivery = await this.choferDe(userId);
    return this.conCerrojoDelLote(batchId, async () => {
      const batch = await this.loteDe(batchId, delivery.distributorId);
      if (
        batch.status === RouteBatchStatus.ASSIGNED &&
        batch.deliveryId === delivery.deliveryId
      ) {
        return {
          batchId,
          accepted: true,
          assignedOrders: await this.stops.count({
            where: { batchId, active: true },
          }),
        };
      }
      const oferta = await this.ofertaViva(batchId, delivery.deliveryId);
      if (oferta.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException('La oferta del lote venció');
      }
      // Un chofer deshabilitado o con algo vencido no acepta: la oferta queda como estaba.
      this.deliveries.assertElegibleParaAsignacion(delivery);
      await this.fleet.assertChoferHabilitado(
        delivery.userId,
        delivery.distributorId,
      );

      // La capacidad se vuelve a medir: el vehículo en uso pudo cambiar desde la oferta.
      const capacidad = await this.capacidadDelChofer(
        delivery.userId,
        delivery.distributorId,
      );
      if (capacidad !== null && batch.totalWeightKg > capacidad) {
        throw new ConflictException(
          'El vehículo en uso no carga el peso del lote',
        );
      }

      const paradas = await this.stops.find({
        where: { batchId, active: true },
        order: { sequence: 'ASC' },
      });
      const asignados: string[] = [];
      const sueltos: string[] = [];
      for (const parada of paradas) {
        const asignado = await this.asignarParada(
          parada,
          delivery,
          asignados.length === 0,
        );
        (asignado ? asignados : sueltos).push(parada.orderId);
      }
      if (asignados.length === 0) {
        await this.deshacerLote(
          batchId,
          RouteBatchCloseReason.ORDERS_UNAVAILABLE,
        );
        throw new ConflictException(
          'Los pedidos del lote ya no están disponibles',
        );
      }
      await this.cerrarAceptacion(batchId, oferta.offerId, delivery, sueltos);
      this.notifier.loteAsignado(delivery.userId, batchId, asignados);
      await this.devolverAM1(sueltos);
      this.logger.log(
        `Lote ${batchId} aceptado por el chofer ${delivery.userId}: ${asignados.length} pedido(s) asignado(s)`,
      );
      return { batchId, accepted: true, assignedOrders: asignados.length };
    });
  }

  /**
   * Asigna un pedido del lote. Devuelve `false` si el pedido ya no está
   * disponible (cancelado o asignado aparte). Un error que no es del pedido
   * (el chofer no puede cargar, por ejemplo) se propaga si todavía no se asignó
   * nada: la oferta queda viva y no hay nada que deshacer.
   */
  private async asignarParada(
    parada: RouteBatchStop,
    delivery: Delivery,
    esLaPrimera: boolean,
  ): Promise<boolean> {
    try {
      await this.orderService.assignDelivery(
        parada.orderId,
        delivery.deliveryId,
        delivery.distributorId,
        // Un pedido que otro chofer o un admin ya tomó no se reasigna: sale del lote.
        { soloSiLibre: true },
      );
      return true;
    } catch (error) {
      const pedido = await this.orderService.findById(parada.orderId);
      const sigueDisponible =
        pedido?.status === OrderStatus.PENDING &&
        !pedido.deliveryId &&
        !pedido.paymentFraudHold;
      if (sigueDisponible && esLaPrimera) throw error;
      this.logger.warn(
        `Lote ${parada.batchId}: el pedido ${parada.orderId} no se asignó: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /** Cierra la oferta como aceptada y deja el lote asignado; las paradas que no se asignaron salen. */
  private async cerrarAceptacion(
    batchId: string,
    offerId: string,
    delivery: Delivery,
    sueltos: string[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const batch = await this.bloquearLote(manager, batchId);
      if (batch.status !== RouteBatchStatus.OFFERED) return;
      await manager.update(
        RouteBatchOffer,
        { offerId, status: ProposalStatus.PENDING },
        { status: ProposalStatus.ACCEPTED, respondedAt: new Date() },
      );
      if (sueltos.length > 0) {
        await manager.update(
          RouteBatchStop,
          { batchId, orderId: In(sueltos) },
          { active: false },
        );
      }
      await manager.update(
        RouteBatch,
        { batchId },
        {
          status: RouteBatchStatus.ASSIGNED,
          deliveryId: delivery.deliveryId,
        },
      );
    });
  }

  /** Paso 9: el chofer rechaza; la oferta se cierra y el lote pasa al siguiente de inmediato. */
  async rechazar(
    userId: string,
    batchId: string,
  ): Promise<ResultadoDeDecision> {
    const delivery = await this.choferDe(userId);
    return this.conCerrojoDelLote(batchId, async () => {
      await this.loteDe(batchId, delivery.distributorId);
      const oferta = await this.ofertaViva(batchId, delivery.deliveryId);
      await this.offers.update(
        { offerId: oferta.offerId, status: ProposalStatus.PENDING },
        { status: ProposalStatus.REJECTED, respondedAt: new Date() },
      );
      await this.siguienteOferta(batchId, new Date());
      return { batchId, accepted: false, assignedOrders: 0 };
    });
  }

  /**
   * Pasos 7, 9 y 10 a 11: la oferta siguiente. Antes revisa que los pedidos
   * sigan disponibles (los cancelados o asignados aparte salen del lote); con
   * menos de dos, o sin choferes que no hayan sido contactados y puedan
   * cargarlo, el lote se deshace.
   */
  private async siguienteOferta(
    batchId: string,
    ahora: Date,
  ): Promise<'ofrecido' | 'deshecho' | 'nada'> {
    const batch = await this.batches.findOne({ where: { batchId } });
    if (!batch || batch.status !== RouteBatchStatus.OFFERED) return 'nada';
    if (
      await this.offers.exist({
        where: { batchId, status: ProposalStatus.PENDING },
      })
    ) {
      return 'nada';
    }

    // Apagado el módulo no se sigue buscando chofer: el lote se deshace y sus
    // pedidos vuelven al despacho individual.
    if (!(await this.estaEncendido(batch.distributorId))) {
      await this.deshacerLote(batchId, RouteBatchCloseReason.ADMIN);
      return 'deshecho';
    }
    const vigentes = await this.retirarParadasNoDisponibles(batch);
    if (vigentes.length < 2) {
      await this.deshacerLote(
        batchId,
        RouteBatchCloseReason.ORDERS_UNAVAILABLE,
      );
      return 'deshecho';
    }

    const params = this.agrupacion(await this.parametros(batch.distributorId));
    const contactados = new Set(
      (await this.offers.find({ where: { batchId } })).map((o) => o.deliveryId),
    );
    const ocupados = await this.choferesOcupados();
    const excluidos = new Set([...contactados, ...ocupados]);
    const puntoDePartida = await this.puntoDelPedido(vigentes[0].orderId);
    const peso = batch.totalWeightKg;
    const chofer = puntoDePartida
      ? (
          await this.choferesCerca(
            batch.distributorId,
            puntoDePartida.lat,
            puntoDePartida.lng,
            excluidos,
          )
        ).find((c) => c.capacidadKg === null || c.capacidadKg >= peso)
      : undefined;
    if (!chofer) {
      await this.deshacerLote(batchId, RouteBatchCloseReason.EXHAUSTED);
      return 'deshecho';
    }

    let oferta: RouteBatchOffer | null;
    try {
      oferta = await this.dataSource.transaction(async (manager) => {
        const bloqueado = await this.bloquearLote(manager, batchId);
        if (bloqueado.status !== RouteBatchStatus.OFFERED) return null;
        return this.crearOferta(
          manager,
          batchId,
          chofer.deliveryId,
          params.offerTtlSeconds,
          ahora,
        );
      });
    } catch (error) {
      if (esViolacionDeUnico(error)) return 'nada';
      throw error;
    }
    if (!oferta) return 'nada';
    this.logger.log(
      `Lote ${batchId} ofrecido al chofer ${chofer.userId} (vence ${oferta.expiresAt.toISOString()})`,
    );
    await this.avisarOferta(chofer.deliveryId, batch, oferta);
    return 'ofrecido';
  }

  /**
   * Saca del lote las paradas cuyo pedido ya no está pendiente y sin chofer, y
   * recalcula el peso con las que quedan. Devuelve las que siguen vigentes.
   */
  private async retirarParadasNoDisponibles(
    batch: RouteBatch,
  ): Promise<RouteBatchStop[]> {
    const paradas = await this.stops.find({
      where: { batchId: batch.batchId, active: true },
      order: { sequence: 'ASC' },
    });
    const pedidos = await this.dataSource.getRepository(Order).find({
      where: { orderId: In(paradas.map((p) => p.orderId)) },
      select: {
        orderId: true,
        status: true,
        deliveryId: true,
        paymentFraudHold: true,
      },
    });
    const disponibles = new Set(
      pedidos
        .filter(
          (p) =>
            p.status === OrderStatus.PENDING &&
            !p.deliveryId &&
            !p.paymentFraudHold,
        )
        .map((p) => p.orderId),
    );
    const vigentes = paradas.filter((p) => disponibles.has(p.orderId));
    const sacadas = paradas.filter((p) => !disponibles.has(p.orderId));
    if (sacadas.length > 0) {
      await this.stops.update(
        { stopId: In(sacadas.map((p) => p.stopId)) },
        { active: false },
      );
      const peso = await this.pesoDe(vigentes.map((p) => p.orderId));
      await this.batches.update(
        { batchId: batch.batchId },
        { totalWeightKg: peso },
      );
      batch.totalWeightKg = peso;
    }
    return vigentes;
  }

  private async pesoDe(orderIds: string[]): Promise<number> {
    if (orderIds.length === 0) return 0;
    const [fila]: Array<{ peso: string }> = await this.dataSource.query(
      `SELECT COALESCE(SUM(oi."quantity" * gc."weight"), 0) AS "peso"
         FROM "order_item" oi
         JOIN "gas_cylinder" gc ON gc."gas_cylinder_id" = oi."gas_cylinder_id"
        WHERE oi."order_id" = ANY($1::uuid[])`,
      [orderIds],
    );
    return Math.round(Number(fila.peso) * 100) / 100;
  }

  private async puntoDelPedido(
    orderId: string,
  ): Promise<{ lat: number; lng: number } | null> {
    const [fila]: Array<{ lat: string | null; lng: string | null }> =
      await this.dataSource.query(
        `SELECT ST_Y("deliveryPoint") AS "lat", ST_X("deliveryPoint") AS "lng" FROM "order" WHERE "order_id" = $1`,
        [orderId],
      );
    if (!fila || fila.lat === null || fila.lng === null) return null;
    return { lat: Number(fila.lat), lng: Number(fila.lng) };
  }

  /**
   * Deshace el lote: la oferta viva se cierra, las paradas salen y los pedidos
   * vuelven al despacho individual (M1). Es lo que ocurre cuando se agotan los
   * choferes (paso 11), cuando se cae por debajo de dos pedidos y cuando lo
   * pide el administrador.
   */
  private async deshacerLote(
    batchId: string,
    motivo: RouteBatchCloseReason,
  ): Promise<RouteBatch | null> {
    const { batch, pedidos, choferesAvisados } =
      await this.dataSource.transaction(async (manager) => {
        const lote = await this.bloquearLote(manager, batchId);
        if (
          lote.status !== RouteBatchStatus.FORMING &&
          lote.status !== RouteBatchStatus.OFFERED
        ) {
          return { batch: null, pedidos: [], choferesAvisados: [] };
        }
        const vivas = await manager.find(RouteBatchStop, {
          where: { batchId, active: true },
        });
        const pendientes = await manager.find(RouteBatchOffer, {
          where: { batchId, status: ProposalStatus.PENDING },
        });
        if (pendientes.length > 0) {
          await manager.update(
            RouteBatchOffer,
            { batchId, status: ProposalStatus.PENDING },
            { status: ProposalStatus.EXPIRED, respondedAt: new Date() },
          );
        }
        await manager.update(RouteBatchStop, { batchId }, { active: false });
        await manager.update(
          RouteBatch,
          { batchId },
          {
            status: RouteBatchStatus.DISSOLVED,
            closedAt: new Date(),
            closeReason: motivo,
          },
        );
        return {
          batch: lote,
          pedidos: vivas.map((s) => s.orderId),
          choferesAvisados: pendientes.map((o) => o.deliveryId),
        };
      });
    if (!batch) return null;

    this.logger.log(
      `Lote ${batchId} deshecho (${motivo}): ${pedidos.length} pedido(s) vuelven al despacho individual`,
    );
    for (const deliveryId of choferesAvisados) {
      const delivery = await this.deliveries.buscarPorIdOUsuario(deliveryId);
      if (delivery) {
        this.notifier.ofertaCerrada(delivery.userId, batchId, 'dissolved');
      }
    }
    if (motivo === RouteBatchCloseReason.EXHAUSTED) {
      this.notifier.loteSinChofer(batch.distributorId, batchId, pedidos.length);
    }
    await this.devolverAM1(pedidos);
    return batch;
  }

  /** Paso 11: los pedidos vuelven al circuito individual; M1 los ofrece como a cualquier otro. */
  private async devolverAM1(orderIds: string[]): Promise<void> {
    for (const orderId of orderIds) {
      try {
        const pedido = await this.orderService.findById(orderId);
        if (pedido) await this.orchestrator.ensureOffered(pedido);
      } catch (error) {
        this.logger.warn(
          `El pedido ${orderId} no se pudo devolver al despacho individual: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** El administrador deshace un lote que todavía no tiene chofer. */
  async deshacerPorAdmin(
    distributorId: string,
    batchId: string,
  ): Promise<RouteBatch> {
    await this.loteDe(batchId, distributorId);
    return this.conCerrojoDelLote(batchId, async () => {
      const lote = await this.deshacerLote(
        batchId,
        RouteBatchCloseReason.ADMIN,
      );
      if (!lote) {
        throw new ConflictException(
          'Sólo se puede deshacer un lote que todavía no tiene chofer',
        );
      }
      return lote;
    });
  }

  // ───────────────────────── vencimientos y cierre (paso 10) ─────────────────────────

  /**
   * Paso 10: vence las ofertas que pasaron su vigencia y ofrece el lote al
   * siguiente. Retoma también los lotes ofrecidos que se quedaron sin oferta
   * viva (el proceso se cayó entre cerrar una y abrir la otra) y completa los
   * recorridos cuyos pedidos ya se entregaron.
   */
  async vencerOfertas(
    ahora: Date = new Date(),
  ): Promise<ResumenDeVencimientos> {
    const resumen: ResumenDeVencimientos = {
      expired: 0,
      rescued: 0,
      completed: 0,
    };
    const vencidas = await this.offers
      .createQueryBuilder('o')
      .where('o.status = :s', { s: ProposalStatus.PENDING })
      .andWhere('o.expiresAt <= :ahora', { ahora })
      .getMany();
    for (const oferta of vencidas) {
      try {
        const vencio = await this.conCerrojoDelLote(
          oferta.batchId,
          async () => {
            const r = await this.offers.update(
              { offerId: oferta.offerId, status: ProposalStatus.PENDING },
              { status: ProposalStatus.EXPIRED, respondedAt: ahora },
            );
            if (!r.affected) return false;
            const delivery = await this.deliveries.buscarPorIdOUsuario(
              oferta.deliveryId,
            );
            if (delivery) {
              this.notifier.ofertaCerrada(
                delivery.userId,
                oferta.batchId,
                'expired',
              );
            }
            await this.siguienteOferta(oferta.batchId, ahora);
            return true;
          },
        );
        if (vencio) resumen.expired += 1;
      } catch (error) {
        this.logger.error(
          `Lote ${oferta.batchId}: no se pudo vencer la oferta: ${errorMessage(error)}`,
        );
      }
    }

    const huerfanos: Array<{ batchId: string }> = await this.dataSource.query(
      `SELECT b."batch_id" AS "batchId" FROM "route_batch" b
        WHERE b."status" = 'offered'
          AND NOT EXISTS (SELECT 1 FROM "route_batch_offer" o
                           WHERE o."batch_id" = b."batch_id" AND o."status" = 'pending')`,
    );
    for (const { batchId } of huerfanos) {
      try {
        const r = await this.conCerrojoDelLote(batchId, () =>
          this.siguienteOferta(batchId, ahora),
        );
        if (r !== 'nada') resumen.rescued += 1;
      } catch (error) {
        this.logger.error(
          `Lote ${batchId}: no se pudo retomar: ${errorMessage(error)}`,
        );
      }
    }

    resumen.completed = await this.completarEntregados(ahora);
    return resumen;
  }

  /** Un recorrido asignado se completa cuando ninguno de sus pedidos sigue en curso. */
  private async completarEntregados(ahora: Date): Promise<number> {
    const filas: Array<{ batchId: string }> = await this.dataSource.query(
      `SELECT b."batch_id" AS "batchId" FROM "route_batch" b
        WHERE b."status" = 'assigned'
          AND NOT EXISTS (SELECT 1 FROM "route_batch_stop" s
                            JOIN "order" o ON o."order_id" = s."order_id"
                           WHERE s."batch_id" = b."batch_id" AND s."active"
                             AND o."status" NOT IN ('delivered', 'cancelled'))`,
    );
    let completados = 0;
    for (const { batchId } of filas) {
      const hecho = await this.dataSource.transaction(async (manager) => {
        const lote = await this.bloquearLote(manager, batchId);
        if (lote.status !== RouteBatchStatus.ASSIGNED) return false;
        await manager.update(RouteBatchStop, { batchId }, { active: false });
        await manager.update(
          RouteBatch,
          { batchId },
          { status: RouteBatchStatus.COMPLETED, closedAt: ahora },
        );
        return true;
      });
      if (hecho) completados += 1;
    }
    return completados;
  }

  // ───────────────────────── utilidades ─────────────────────────

  private async choferDe(userId: string): Promise<Delivery> {
    const delivery = await this.deliveries.buscarPorIdOUsuario(userId);
    if (!delivery || delivery.userId !== userId) {
      throw new ForbiddenException('Sólo un chofer puede responder un lote');
    }
    return delivery;
  }

  /** El lote, o 404 si no existe o es de otra distribuidora (no se distingue). */
  private async loteDe(
    batchId: string,
    distributorId: string,
  ): Promise<RouteBatch> {
    const batch = await this.batches.findOne({ where: { batchId } });
    if (!batch || batch.distributorId !== distributorId) {
      throw new NotFoundException('Lote no encontrado');
    }
    return batch;
  }

  private async ofertaViva(
    batchId: string,
    deliveryId: string,
  ): Promise<RouteBatchOffer> {
    const oferta = await this.offers.findOne({
      where: { batchId, deliveryId, status: ProposalStatus.PENDING },
    });
    if (!oferta) {
      throw new ConflictException('Esta oferta de lote ya no está vigente');
    }
    return oferta;
  }

  private bloquearLote(
    manager: EntityManager,
    batchId: string,
  ): Promise<RouteBatch> {
    return manager
      .createQueryBuilder(RouteBatch, 'b')
      .setLock('pessimistic_write')
      .where('b.batchId = :batchId', { batchId })
      .getOneOrFail();
  }

  private async conCerrojoDelLote<T>(
    batchId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const r = await this.redis.withLock(
      `route-batch:${batchId}`,
      CERROJO_TTL_MS,
      fn,
      ESPERA_DEL_CERROJO_MS,
    );
    if (!r.obtenido) {
      throw new ConflictException('El lote se está procesando, reintentá');
    }
    return r.valor;
  }
}
