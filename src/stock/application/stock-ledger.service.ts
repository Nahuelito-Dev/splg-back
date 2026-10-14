import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { traducirErrorDeBase } from '../../common/errors/db-exceptions';
import {
  FaltanteDeStock,
  GarrafaNoEncontradaEnStockError,
  LoteNoEncontradoError,
  OperacionDeStockInvalidaError,
  StockInsuficienteError,
  UbicacionNoEncontradaError,
} from '../domain/errors/stock.errors';
import {
  MovimientoDeStock,
  OperacionDeStock,
  ResultadoDeOperacion,
  StockLedgerPort,
} from '../domain/ports/stock-ledger.port';
import {
  cambioDeLlenasPorGarrafa,
  claveDeSaldo,
  DeltaDeSaldo,
  netearSaldos,
  validarMovimiento,
} from '../domain/stock-rules';
import { StockCondition, StockMovementReason } from '../domain/stock.enums';
import { StockMovement } from '../entities/stock-movement.entity';
import { ahoraDeLaBase } from './reloj-de-la-base';

interface UbicacionConocida {
  locationId: string;
  label: string;
}

interface SaldoBloqueado {
  location_id: string;
  gas_cylinder_id: string;
  condition: StockCondition;
  quantity: number;
}

/** Motivos de movimiento que no cambian el vendible: ya se descontó al reservar. */
const MOTIVOS_SIN_EFECTO_EN_VENDIBLE: readonly StockMovementReason[] = [
  StockMovementReason.DELIVERY,
  StockMovementReason.EMPTY_COLLECTED,
];

/**
 * El único que mueve stock. Cada operación, dentro de la transacción de quien
 * llama:
 *  1. valida los movimientos y que ubicaciones y garrafas sean de la
 *     distribuidora (404 si no);
 *  2. si el vendible acompaña al físico, bloquea `gas_cylinder` (por id) y lo
 *     ajusta (nunca lo deja negativo: una pérdida lo deja en cero);
 *  3. asegura las filas de saldo, las bloquea `FOR UPDATE` ordenadas por
 *     (ubicación, tipo, condición) y valida que ninguna quede negativa;
 *  4. actualiza los saldos e inserta el libro.
 *
 * Orden de locks (CONVENCIONES / diseño M-C §1.2): `gas_cylinder` antes que
 * `stock_balance`, y `document_sequence` al final. Un llamador que ya tomó
 * otros locks (`car`, `delivery`) los toma antes de llamar acá.
 */
@Injectable()
export class StockLedgerService extends StockLedgerPort {
  private readonly logger = new Logger(StockLedgerService.name);

  constructor(private readonly gasCylinders: GasCylinderService) {
    super();
  }

  async aplicar(
    manager: EntityManager,
    op: OperacionDeStock,
  ): Promise<ResultadoDeOperacion> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error(
        'StockLedgerService.aplicar tiene que llamarse dentro de una transacción',
      );
    }
    if (op.movimientos.length === 0) {
      throw new OperacionDeStockInvalidaError(
        'La operación no tiene movimientos',
      );
    }
    op.movimientos.forEach(validarMovimiento);

    const garrafas = await this.cargarGarrafas(manager, op);
    await this.bloquearGarrafas(manager, op, [...garrafas.keys()]);
    const ubicaciones = await this.cargarUbicaciones(manager, op);

    await this.aplicarSaldos(
      manager,
      op.distributorId,
      netearSaldos(op.movimientos),
      ubicaciones,
      garrafas,
    );

    const batchId = op.batchId ?? randomUUID();
    const movementIds = await this.insertarMovimientos(manager, op, batchId);
    return { batchId, movementIds };
  }

  async contraasentar(
    manager: EntityManager,
    args: {
      distributorId: string;
      batchId: string;
      actorUserId: string | null;
      notes?: string | null;
    },
  ): Promise<ResultadoDeOperacion> {
    const originales = await manager.find(StockMovement, {
      where: { distributorId: args.distributorId, batchId: args.batchId },
      order: { createdAt: 'ASC', movementId: 'ASC' },
    });
    if (originales.length === 0) {
      throw new LoteNoEncontradoError(args.batchId);
    }
    if (originales.some((m) => m.reason === StockMovementReason.REVERSAL)) {
      throw new OperacionDeStockInvalidaError(
        'Un contraasiento no se vuelve a contraasentar: registrá la operación de nuevo',
      );
    }
    const yaCorregidos: Array<{ reversed_movement_id: string }> =
      await manager.query(
        `SELECT "reversed_movement_id" FROM "stock_movement"
         WHERE "reversed_movement_id" = ANY($1::uuid[])`,
        [originales.map((m) => m.movementId)],
      );
    if (yaCorregidos.length > 0) {
      throw new ConflictException('Ese lote ya fue contraasentado');
    }

    const movimientos: MovimientoDeStock[] = originales.map((m) => ({
      gasCylinderId: m.gasCylinderId,
      quantity: m.quantity,
      from: m.toLocationId
        ? { locationId: m.toLocationId, condition: m.toCondition! }
        : null,
      to: m.fromLocationId
        ? { locationId: m.fromLocationId, condition: m.fromCondition! }
        : null,
      reason: StockMovementReason.REVERSAL,
      reverses: m.movementId,
    }));
    const sinEfectoEnVendible = originales.every((m) =>
      MOTIVOS_SIN_EFECTO_EN_VENDIBLE.includes(m.reason),
    );

    try {
      return await this.aplicar(manager, {
        distributorId: args.distributorId,
        referenceType: originales[0].referenceType,
        referenceId: originales[0].referenceId,
        actorUserId: args.actorUserId,
        notes: args.notes ?? null,
        movimientos,
        vendible: sinEfectoEnVendible ? 'sin-cambio' : 'sigue-al-fisico',
      });
    } catch (error) {
      if (error instanceof StockInsuficienteError) {
        throw new ConflictException(
          `No se puede contraasentar: las garrafas ya no están donde estaban. ${error.message}`,
        );
      }
      return traducirErrorDeBase(error, this.logger, 'contraasiento de stock');
    }
  }

  /**
   * Toma el lock de `gas_cylinder` de TODAS las garrafas de la operación, por
   * id ascendente y ANTES que cualquier saldo. Sin esto, una entrega o una
   * transferencia (que no cambian el vendible) tomaban los saldos y recién
   * después el `INSERT` del libro pedía `KEY SHARE` sobre `gas_cylinder` por la
   * clave foránea: el orden quedaba invertido respecto de un ajuste (que bloquea
   * `gas_cylinder` y después los saldos) y Postgres abortaba una por deadlock.
   *
   * Modo por garrafa, en una sola pasada ordenada:
   *  - si el vendible acompaña al físico, `FOR UPDATE` (lo hace
   *    `ajustarVendible`, el mismo lock que `reservarStock`);
   *  - si no, `FOR KEY SHARE`: es exactamente lo que pide la clave foránea,
   *    no choca con otras entregas ni transferencias y sólo espera a quien
   *    tenga `FOR UPDATE` (un ajuste o un pedido nuevo). No se usa `FOR UPDATE`
   *    para todo porque serializaría todas las entregas de una garrafa, ni se
   *    sube de un modo a otro dentro de la transacción (dos que suben a la vez
   *    se traban entre sí).
   */
  private async bloquearGarrafas(
    manager: EntityManager,
    op: OperacionDeStock,
    ids: string[],
  ): Promise<void> {
    const cambio =
      (op.vendible ?? 'sigue-al-fisico') === 'sigue-al-fisico'
        ? cambioDeLlenasPorGarrafa(op.movimientos)
        : new Map<string, number>();
    for (const gasCylinderId of [...ids].sort((a, b) => a.localeCompare(b))) {
      const delta = cambio.get(gasCylinderId);
      if (delta !== undefined) {
        // La pérdida física se registra siempre: si el vendible no alcanza queda
        // en cero y el exceso de reservas lo informa la conciliación.
        const recortes = await this.gasCylinders.ajustarVendible(
          manager,
          op.distributorId,
          [{ gasCylinderId, delta }],
          { recortarEnCero: true },
        );
        for (const r of recortes) {
          this.logger.warn(
            `Vendible de ${r.type} recortado a 0: el físico bajó ${r.faltante} por debajo de lo reservado por pedidos abiertos (distribuidora ${op.distributorId})`,
          );
        }
      } else {
        await manager.query(
          `SELECT 1 FROM "gas_cylinder" WHERE "gas_cylinder_id" = $1 FOR KEY SHARE`,
          [gasCylinderId],
        );
      }
    }
  }

  private async cargarUbicaciones(
    manager: EntityManager,
    op: OperacionDeStock,
  ): Promise<Map<string, UbicacionConocida>> {
    const ids = [
      ...new Set(
        op.movimientos.flatMap((m) =>
          [m.from?.locationId, m.to?.locationId].filter(
            (id): id is string => id !== undefined,
          ),
        ),
      ),
    ];
    const filas: Array<{
      location_id: string;
      warehouse_id: string | null;
      label: string;
      inactivo: boolean;
      vehiculo_de_baja: boolean;
    }> = await manager.query(
      `SELECT l."location_id", l."warehouse_id",
              COALESCE(NOT w."is_active", false) AS inactivo,
              (c."deletedAt" IS NOT NULL) AS vehiculo_de_baja,
              COALESCE(w."name", 'vehículo ' || COALESCE(c."car_patent", l."car_id"::text)) AS label
       FROM "stock_location" l
       LEFT JOIN "warehouse" w ON w."warehouse_id" = l."warehouse_id"
       LEFT JOIN "car" c ON c."car_id" = l."car_id" -- incluye vehículos dados de baja
       WHERE l."location_id" = ANY($1::uuid[]) AND l."distributor_id" = $2`,
      [ids, op.distributorId],
    );
    const conocidas = new Map(
      filas.map((f) => [
        f.location_id,
        { locationId: f.location_id, label: f.label },
      ]),
    );
    const faltante = ids.find((id) => !conocidas.has(id));
    if (faltante) throw new UbicacionNoEncontradaError(faltante);

    // Un depósito inactivo o un vehículo dado de baja pueden SEGUIR entregando
    // (para vaciarlos), pero no reciben stock nuevo.
    const destinos = new Set(
      op.movimientos
        .map((m) => m.to?.locationId)
        .filter((id): id is string => id !== undefined),
    );
    for (const f of filas) {
      if (destinos.has(f.location_id) && f.inactivo) {
        throw new OperacionDeStockInvalidaError(
          `${f.label} está inactivo: no recibe stock`,
        );
      }
      if (destinos.has(f.location_id) && f.vehiculo_de_baja) {
        throw new OperacionDeStockInvalidaError(
          `${f.label} está dado de baja: no recibe stock`,
        );
      }
    }

    // Un depósito dado de baja no recibe ni entrega nada. El lock compartido
    // frena la baja de un depósito mientras esta operación lo usa: la baja
    // pide el lock exclusivo y, cuando lo obtiene, ya ve el saldo nuevo.
    const depositos = filas
      .map((f) => f.warehouse_id)
      .filter((id): id is string => id !== null);
    if (depositos.length > 0) {
      const vigentes: Array<{ warehouse_id: string }> = await manager.query(
        `SELECT "warehouse_id" FROM "warehouse"
         WHERE "warehouse_id" = ANY($1::uuid[]) AND "deletedAt" IS NULL
         ORDER BY "warehouse_id"
         FOR SHARE`,
        [depositos],
      );
      const vivos = new Set(vigentes.map((v) => v.warehouse_id));
      const muerto = filas.find(
        (f) => f.warehouse_id !== null && !vivos.has(f.warehouse_id),
      );
      if (muerto) throw new UbicacionNoEncontradaError(muerto.location_id);
    }
    return conocidas;
  }

  private async cargarGarrafas(
    manager: EntityManager,
    op: OperacionDeStock,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(op.movimientos.map((m) => m.gasCylinderId))];
    const filas: Array<{ gas_cylinder_id: string; type: string }> =
      await manager.query(
        `SELECT "gas_cylinder_id", "type" FROM "gas_cylinder"
         WHERE "gas_cylinder_id" = ANY($1::uuid[]) AND "distributor_id" = $2`,
        [ids, op.distributorId],
      );
    const tipos = new Map(filas.map((f) => [f.gas_cylinder_id, f.type]));
    const faltante = ids.find((id) => !tipos.has(id));
    if (faltante) {
      throw new GarrafaNoEncontradaEnStockError(faltante);
    }
    return tipos;
  }

  private async aplicarSaldos(
    manager: EntityManager,
    distributorId: string,
    saldos: DeltaDeSaldo[],
    ubicaciones: Map<string, UbicacionConocida>,
    garrafas: Map<string, string>,
  ): Promise<void> {
    if (saldos.length === 0) return;

    // Las filas que van a recibir stock se aseguran antes del lock; las que
    // sólo entregan tienen que existir (si no, el saldo es 0 y no alcanza).
    const aSumar = saldos.filter((s) => s.delta > 0);
    if (aSumar.length > 0) {
      await manager.query(
        `INSERT INTO "stock_balance" ("distributor_id", "location_id", "gas_cylinder_id", "condition", "quantity")
         SELECT $1, k.l, k.g, k.c::"stock_condition_enum", 0
         FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS k(l, g, c)
         ON CONFLICT ("location_id", "gas_cylinder_id", "condition") DO NOTHING`,
        [
          distributorId,
          aSumar.map((s) => s.locationId),
          aSumar.map((s) => s.gasCylinderId),
          aSumar.map((s) => s.condition),
        ],
      );
    }

    const bloqueados: SaldoBloqueado[] = await manager.query(
      `SELECT b."location_id", b."gas_cylinder_id", b."condition", b."quantity"
       FROM "stock_balance" b
       JOIN unnest($1::uuid[], $2::uuid[], $3::text[]) AS k(l, g, c)
         ON b."location_id" = k.l AND b."gas_cylinder_id" = k.g AND b."condition"::text = k.c
       ORDER BY b."location_id", b."gas_cylinder_id", b."condition"
       FOR UPDATE OF b`,
      [
        saldos.map((s) => s.locationId),
        saldos.map((s) => s.gasCylinderId),
        saldos.map((s) => s.condition),
      ],
    );
    const actuales = new Map(
      bloqueados.map((b) => [
        claveDeSaldo(b.location_id, b.gas_cylinder_id, b.condition),
        b.quantity,
      ]),
    );

    const faltantes: FaltanteDeStock[] = [];
    for (const s of saldos) {
      const disponible =
        actuales.get(
          claveDeSaldo(s.locationId, s.gasCylinderId, s.condition),
        ) ?? 0;
      if (disponible + s.delta < 0) {
        faltantes.push({
          locationId: s.locationId,
          locationLabel: ubicaciones.get(s.locationId)?.label ?? s.locationId,
          gasCylinderId: s.gasCylinderId,
          gasCylinderType: garrafas.get(s.gasCylinderId) ?? s.gasCylinderId,
          condition: s.condition,
          available: disponible,
          requested: -s.delta,
        });
      }
    }
    if (faltantes.length > 0) throw new StockInsuficienteError(faltantes);

    await manager.query(
      `UPDATE "stock_balance" b
       SET "quantity" = b."quantity" + d.delta, "updatedAt" = now()
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::int[]) AS d(l, g, c, delta)
       WHERE b."location_id" = d.l AND b."gas_cylinder_id" = d.g AND b."condition"::text = d.c`,
      [
        saldos.map((s) => s.locationId),
        saldos.map((s) => s.gasCylinderId),
        saldos.map((s) => s.condition),
        saldos.map((s) => s.delta),
      ],
    );
  }

  private async insertarMovimientos(
    manager: EntityManager,
    op: OperacionDeStock,
    batchId: string,
  ): Promise<string[]> {
    const ocurrio = op.occurredAt ?? (await ahoraDeLaBase(manager));
    // SQL directo y no el query builder: así el ledger funciona también con un
    // DataSource sin entidades registradas (los seeds).
    const COLUMNAS = 15;
    const params: unknown[] = [];
    const filasSql = op.movimientos.map((m) => {
      params.push(
        op.distributorId,
        m.gasCylinderId,
        batchId,
        m.quantity,
        m.from?.locationId ?? null,
        m.from?.condition ?? null,
        m.to?.locationId ?? null,
        m.to?.condition ?? null,
        m.reason,
        op.referenceType,
        op.referenceId,
        m.reverses ?? null,
        op.notes ?? null,
        op.actorUserId,
        ocurrio,
      );
      const n = params.length - COLUMNAS;
      return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}::"stock_condition_enum", $${n + 7}, $${n + 8}::"stock_condition_enum", $${n + 9}::"stock_movement_reason_enum", $${n + 10}::"stock_movement_reference_type_enum", $${n + 11}, $${n + 12}, $${n + 13}, $${n + 14}, $${n + 15})`;
    });
    const filas: Array<{ movement_id: string }> = await manager.query(
      `INSERT INTO "stock_movement"
         ("distributor_id", "gas_cylinder_id", "batch_id", "quantity", "from_location_id", "from_condition",
          "to_location_id", "to_condition", "reason", "reference_type", "reference_id",
          "reversed_movement_id", "notes", "actor_user_id", "occurred_at")
       VALUES ${filasSql.join(', ')}
       RETURNING "movement_id"`,
      params,
    );
    return filas.map((f) => f.movement_id);
  }
}
