/**
 * Historia de stock, compras y cargas de camión de la demo (herramienta de
 * desarrollo; el guardia `resguardoDeProduccion` la frena antes de llegar acá).
 *
 * TODO el stock físico pasa por el libro (`StockLedgerService`), igual que en la
 * aplicación, así que la conciliación da consistente por construcción:
 *
 *   vendible (`gas_cylinder.stock`) = llenas (depósitos + camiones) − reservadas
 *
 * La cuenta que lo garantiza: el conteo inicial entra con `vendible: sin-cambio`
 * por `stock inicial + reservadas + entregadas desde entonces`; las entregas
 * descuentan el físico sin tocar el vendible (ya se descontó al reservar); las
 * compras, los ajustes y las mermas mueven los dos a la vez.
 */
import { EntityManager, DataSource } from 'typeorm';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { StockLedgerService } from '../../src/stock/application/stock-ledger.service';
import {
  StockAdjustmentReason,
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';
import { movimientosDeAjuste } from '../../src/stock/domain/stock-rules';
import { MovimientoDeStock } from '../../src/stock/domain/ports/stock-ledger.port';
import {
  esperadoDe,
  planDeCierre,
} from '../../src/truck-load/domain/truck-load-rules';
import {
  costoPromedioPonderado,
  totalDe,
} from '../../src/purchase/domain/purchase-rules';
import { garrafasDelSeed } from './purchase-demo';
import { cuitDe } from './rng-demo';

const DIA_MS = 24 * 60 * 60 * 1000;
const hace = (dias: number, horas = 0): Date =>
  new Date(Date.now() - dias * DIA_MS - horas * 60 * 60 * 1000);

export interface ProductoDeStock {
  id: string;
  type: string;
  price: number;
  weight: number;
}

export interface PedidoParaStock {
  id: string;
  estado: string;
  entregadoEl: Date | null;
  deliveryId: string | null;
  carId: string | null;
  items: Array<{ gasCylinderId: string; quantity: number }>;
}

export interface ChoferParaStock {
  deliveryId: string;
  userId: string;
  carId: string;
  /** Ayudante (empleado) que sale con ese chofer, si lo tiene. */
  ayudanteId: string | null;
}

export interface ContextoDeStock {
  distributorId: string;
  adminUserId: string;
  productos: ProductoDeStock[];
  pedidos: PedidoParaStock[];
  choferes: ChoferParaStock[];
}

export interface ResumenDeStock {
  depositos: number;
  umbrales: number;
  conteoInicial: number;
  entregasEnLibro: number;
  transferencias: number;
  ajustes: number;
  proveedores: number;
  ordenesDeCompra: number;
  recepciones: number;
  cargasDeCamion: number;
  /** Para colgarles el archivo del remito. */
  recepcionesIds: Array<{ receiptId: string; numero: string }>;
  /** Documentos creados, para la auditoría. */
  documentos: Array<{
    entidad: string;
    id: string;
    cuando: Date;
    detalle: Record<string, string>;
  }>;
}

const AJUSTES_DEL_SEED: Array<{
  reason: StockAdjustmentReason;
  peso: number;
  condition: StockCondition;
  delta: number;
  notas: string;
  dias: number;
}> = [
  {
    reason: StockAdjustmentReason.LEAK,
    peso: 15,
    condition: StockCondition.FULL,
    delta: -1,
    notas:
      'Pérdida de gas por la válvula, detectada en el control del depósito',
    dias: 28,
  },
  {
    reason: StockAdjustmentReason.FOUND,
    peso: 10,
    condition: StockCondition.EMPTY,
    delta: 3,
    notas: 'Envases vacíos que estaban apilados detrás del galpón',
    dias: 21,
  },
  {
    reason: StockAdjustmentReason.DAMAGED,
    peso: 10,
    condition: StockCondition.FULL,
    delta: -1,
    notas: 'Garrafa golpeada al descargar: pasa a defectuosa para revisión',
    dias: 9,
  },
  {
    reason: StockAdjustmentReason.COUNT_CORRECTION,
    peso: 5,
    condition: StockCondition.EMPTY,
    delta: -2,
    notas: 'Corrección tras el conteo físico de fin de mes',
    dias: 4,
  },
];

const PLAN_DE_COMPRAS: Array<
  Omit<OrdenPlaneada, 'proveedor'> & { proveedor: 'litoral' | 'misionera' }
> = [
  {
    numero: 1,
    proveedor: 'litoral',
    estado: 'received',
    emitidaHaceDias: 52,
    recibidaHaceDias: 50,
    renglones: [
      { peso: 5, pedido: 60, recibido: 60 },
      { peso: 10, pedido: 90, recibido: 90 },
      { peso: 15, pedido: 40, recibido: 40 },
      { peso: 25, pedido: 20, recibido: 20 },
    ],
    remito: { tipo: 'delivery_note', numero: '0001-00004567', pagada: true },
    notas: 'Reposición mensual',
  },
  {
    numero: 2,
    proveedor: 'misionera',
    estado: 'received',
    emitidaHaceDias: 33,
    recibidaHaceDias: 31,
    renglones: [
      { peso: 10, pedido: 70, recibido: 70 },
      { peso: 15, pedido: 30, recibido: 30 },
    ],
    remito: { tipo: 'invoice', numero: '0003-00012345', pagada: true },
    notas: 'Compra de oportunidad por precio de lista menor',
  },
  {
    numero: 3,
    proveedor: 'litoral',
    estado: 'closed_short',
    emitidaHaceDias: 16,
    recibidaHaceDias: 15,
    renglones: [
      { peso: 10, pedido: 80, recibido: 60 },
      { peso: 25, pedido: 20, recibido: 20 },
    ],
    remito: { tipo: 'delivery_note', numero: '0001-00004702', pagada: false },
    notas: 'Reposición quincenal',
    cierre:
      'La planta no completó el pedido por falta de producto: se cierra con 20 garrafas de 10 kg de faltante',
  },
  {
    numero: 4,
    proveedor: 'misionera',
    estado: 'partially_received',
    emitidaHaceDias: 7,
    recibidaHaceDias: 5,
    renglones: [
      { peso: 5, pedido: 40, recibido: 40 },
      { peso: 10, pedido: 60, recibido: 30 },
    ],
    remito: { tipo: 'delivery_note', numero: '0002-00008801', pagada: false },
    notas: 'Entrega en dos tandas; falta la segunda',
  },
  {
    numero: 5,
    proveedor: 'litoral',
    estado: 'sent',
    emitidaHaceDias: 2,
    recibidaHaceDias: null,
    renglones: [
      { peso: 10, pedido: 100, recibido: 0 },
      { peso: 15, pedido: 30, recibido: 0 },
    ],
    notas: 'Reposición de la semana próxima',
  },
  {
    numero: 6,
    proveedor: 'misionera',
    estado: 'draft',
    emitidaHaceDias: 1,
    recibidaHaceDias: null,
    renglones: [{ peso: 5, pedido: 50, recibido: 0 }],
    notas: 'Borrador a confirmar con la planta',
  },
  {
    numero: 7,
    proveedor: 'misionera',
    estado: 'cancelled',
    emitidaHaceDias: 24,
    recibidaHaceDias: null,
    renglones: [{ peso: 25, pedido: 30, recibido: 0 }],
    notas: 'Pedido de garrafas de 25 kg',
    cancelacion:
      'La planta subió el precio y se resolvió comprar a otro proveedor',
  },
];

export async function sembrarStockHistoria(
  ds: DataSource,
  ctx: ContextoDeStock,
): Promise<ResumenDeStock> {
  const ledger = new StockLedgerService(garrafasDelSeed);
  return ds.transaction(async (m) => {
    const resumen: ResumenDeStock = {
      depositos: 0,
      umbrales: 0,
      conteoInicial: 0,
      entregasEnLibro: 0,
      transferencias: 0,
      ajustes: 0,
      proveedores: 0,
      ordenesDeCompra: 0,
      recepciones: 0,
      cargasDeCamion: 0,
      recepcionesIds: [],
      documentos: [],
    };
    const { distributorId, adminUserId } = ctx;
    const porPeso = (w: number) => ctx.productos.find((p) => p.weight === w);

    // ── Depósitos y ubicaciones ────────────────────────────────────────────
    const central = await crearDeposito(m, distributorId, {
      name: 'Depósito central',
      code: 'CENTRAL',
      kind: 'depot',
      address: 'Av. Quaranta 2150, Posadas, Misiones',
      predeterminado: true,
    });
    const norte = await crearDeposito(m, distributorId, {
      name: 'Galpón Norte',
      code: 'NORTE',
      kind: 'branch',
      address: 'Ruta Nacional 12 km 7, Posadas, Misiones',
      predeterminado: false,
    });
    resumen.depositos = 2;
    resumen.documentos.push(
      {
        entidad: 'Warehouse',
        id: central.warehouseId,
        cuando: hace(70),
        detalle: {
          name: 'Depósito central',
          code: 'CENTRAL',
          isDefault: 'true',
        },
      },
      {
        entidad: 'Warehouse',
        id: norte.warehouseId,
        cuando: hace(66),
        detalle: { name: 'Galpón Norte', code: 'NORTE', isDefault: 'false' },
      },
    );

    // Mínimos de llenas: el aviso de stock bajo.
    const MINIMOS: Array<[number, number, number]> = [
      [5, 30, 0],
      [10, 60, 20],
      [15, 20, 0],
      [25, 8, 0],
    ];
    for (const [peso, minCentral, minNorte] of MINIMOS) {
      const p = porPeso(peso);
      if (!p) continue;
      for (const [dep, min] of [
        [central, minCentral],
        [norte, minNorte],
      ] as const) {
        if (min === 0) continue;
        await m.query(
          `INSERT INTO "stock_threshold" ("distributor_id", "warehouse_id", "gas_cylinder_id", "min_full")
           VALUES ($1, $2, $3, $4)`,
          [distributorId, dep.warehouseId, p.id, min],
        );
        resumen.umbrales += 1;
      }
    }

    // ── Conteo inicial (hace ~63 días) ─────────────────────────────────────
    // El vendible de hoy tiene que quedar cerca del catálogo: se parte de lo
    // que ya vendió la compra, el ajuste y la merma (todo eso mueve el vendible).
    const cargas = planearCargas(ctx);
    const neto = new Map<string, number>();
    const sumar = (id: string | undefined, n: number) =>
      id && neto.set(id, (neto.get(id) ?? 0) + n);
    for (const o of PLAN_DE_COMPRAS) {
      if (!o.remito) continue;
      for (const r of o.renglones) sumar(porPeso(r.peso)?.id, r.recibido);
    }
    for (const a of AJUSTES_DEL_SEED) {
      if (a.condition === StockCondition.FULL) {
        sumar(porPeso(a.peso)?.id, a.delta);
      }
    }
    for (const c of cargas) sumar(c.mermaDe ?? undefined, -2);
    for (const p of ctx.productos) {
      await m.query(
        `UPDATE "gas_cylinder" SET "stock" = GREATEST(6, "stock" - $2) WHERE "gas_cylinder_id" = $1`,
        [p.id, neto.get(p.id) ?? 0],
      );
    }
    const reservadas = new Map<string, number>();
    for (const f of (await m.query(
      `SELECT i."gas_cylinder_id", SUM(i."quantity")::int AS total
         FROM "order_item" i JOIN "order" o ON o."order_id" = i."order_id"
        WHERE o."distributor_id" = $1
          AND o."status" IN ('reserved', 'pending', 'accepted', 'on_the_way')
        GROUP BY i."gas_cylinder_id"`,
      [distributorId],
    )) as Array<{ gas_cylinder_id: string; total: number }>) {
      reservadas.set(f.gas_cylinder_id, f.total);
    }
    const entregadas = new Map<string, number>();
    for (const p of ctx.pedidos) {
      if (p.estado !== 'delivered') continue;
      for (const i of p.items) {
        entregadas.set(
          i.gasCylinderId,
          (entregadas.get(i.gasCylinderId) ?? 0) + i.quantity,
        );
      }
    }
    const vendibles = new Map<string, number>(
      (
        (await m.query(
          `SELECT "gas_cylinder_id", "stock" FROM "gas_cylinder" WHERE "distributor_id" = $1`,
          [distributorId],
        )) as Array<{ gas_cylinder_id: string; stock: number }>
      ).map((f) => [f.gas_cylinder_id, f.stock]),
    );
    const inicio = hace(63);
    const conteo: MovimientoDeStock[] = [];
    for (const p of ctx.productos) {
      const llenas =
        (vendibles.get(p.id) ?? 0) +
        (reservadas.get(p.id) ?? 0) +
        (entregadas.get(p.id) ?? 0);
      if (llenas > 0) {
        conteo.push(
          entrada(p.id, llenas, central.locationId, StockCondition.FULL),
        );
      }
      conteo.push(entrada(p.id, 25, central.locationId, StockCondition.EMPTY));
    }
    const defectuosa = porPeso(10);
    if (defectuosa) {
      conteo.push(
        entrada(defectuosa.id, 2, central.locationId, StockCondition.DEFECTIVE),
      );
    }
    await ledger.aplicar(m, {
      distributorId,
      referenceType: StockReferenceType.INITIAL,
      referenceId: null,
      actorUserId: adminUserId,
      vendible: 'sin-cambio',
      occurredAt: inicio,
      notes: 'Conteo inicial del Depósito central',
      movimientos: conteo,
    });
    resumen.conteoInicial = conteo.length;

    // ── Cargas de camión rendidas (con sus entregas) ───────────────────────
    const pedidosDeCarga = new Set<string>();
    let numeroDeCarga = 0;
    for (const plan of cargas) {
      numeroDeCarga += 1;
      await sembrarCargaRendida(m, ledger, ctx, central.locationId, plan, {
        numero: numeroDeCarga,
        resumen,
      });
      plan.pedidos.forEach((p) => pedidosDeCarga.add(p.id));
    }

    // ── Entregas desde el depósito (el resto de los pedidos entregados) ────
    const restantes = ctx.pedidos
      .filter(
        (p) =>
          p.estado === 'delivered' &&
          p.entregadoEl &&
          !pedidosDeCarga.has(p.id),
      )
      .sort((a, b) => a.entregadoEl!.getTime() - b.entregadoEl!.getTime());
    for (const p of restantes) {
      await entregar(m, ledger, ctx, p, central.locationId);
      resumen.entregasEnLibro += 1;
    }

    // ── Compras ────────────────────────────────────────────────────────────
    await sembrarCompras(m, ledger, ctx, central, resumen);

    // ── Transferencias entre depósitos ─────────────────────────────────────
    const p10 = porPeso(10);
    const p5 = porPeso(5);
    if (p10 && p5) {
      await ledger.aplicar(m, {
        distributorId,
        referenceType: StockReferenceType.TRANSFER,
        referenceId: null,
        actorUserId: adminUserId,
        occurredAt: hace(40),
        notes: 'Reposición del Galpón Norte para la zona de Itaembé Miní',
        movimientos: [
          transferencia(p10.id, 30, central, norte, StockCondition.FULL),
          transferencia(p5.id, 12, central, norte, StockCondition.FULL),
          transferencia(p10.id, 10, central, norte, StockCondition.EMPTY),
        ],
      });
      await ledger.aplicar(m, {
        distributorId,
        referenceType: StockReferenceType.TRANSFER,
        referenceId: null,
        actorUserId: adminUserId,
        occurredAt: hace(12),
        notes: 'Devolución de vacías del Galpón Norte al central',
        movimientos: [
          transferencia(p10.id, 6, norte, central, StockCondition.EMPTY),
        ],
      });
      resumen.transferencias = 2;
    }

    // ── Ajustes de stock ───────────────────────────────────────────────────
    let numeroDeAjuste = 0;
    for (const a of AJUSTES_DEL_SEED) {
      const producto = porPeso(a.peso);
      if (!producto) continue;
      numeroDeAjuste += 1;
      const ajusteId = (
        (await m.query(`SELECT gen_random_uuid() AS id`)) as Array<{
          id: string;
        }>
      )[0].id;
      const cuando = hace(a.dias, 3);
      const { batchId } = await ledger.aplicar(m, {
        distributorId,
        referenceType: StockReferenceType.STOCK_ADJUSTMENT,
        referenceId: ajusteId,
        actorUserId: adminUserId,
        occurredAt: cuando,
        notes: a.notas,
        movimientos: movimientosDeAjuste(a.reason, central.locationId, [
          {
            gasCylinderId: producto.id,
            condition: a.condition,
            quantityDelta: a.delta,
          },
        ]),
      });
      await m.query(
        `INSERT INTO "stock_adjustment"
           ("adjustment_id", "distributor_id", "number", "location_id", "reason", "notes", "batch_id", "created_by_user_id", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          ajusteId,
          distributorId,
          numeroDeAjuste,
          central.locationId,
          a.reason,
          a.notas,
          batchId,
          adminUserId,
          cuando,
        ],
      );
      await m.query(
        `INSERT INTO "stock_adjustment_item" ("adjustment_id", "gas_cylinder_id", "condition", "quantity_delta")
         VALUES ($1, $2, $3, $4)`,
        [ajusteId, producto.id, a.condition, a.delta],
      );
      resumen.documentos.push({
        entidad: 'StockAdjustment',
        id: ajusteId,
        cuando,
        detalle: { number: String(numeroDeAjuste), reason: a.reason },
      });
      resumen.ajustes += 1;
    }

    // ── Carga de hoy, abierta (sale con lo que tiene reservado el chofer) ──
    numeroDeCarga += 1;
    if (
      await sembrarCargaAbierta(
        m,
        ledger,
        ctx,
        central.locationId,
        numeroDeCarga,
      )
    ) {
      resumen.cargasDeCamion += 1;
    } else {
      numeroDeCarga -= 1;
    }

    await m.query(
      `INSERT INTO "document_sequence" ("distributor_id", "doc_type", "last_number") VALUES
         ($1, 'stock_adjustment', $2), ($1, 'truck_load', $3)
       ON CONFLICT ("distributor_id", "doc_type") DO UPDATE SET "last_number" = EXCLUDED."last_number"`,
      [distributorId, numeroDeAjuste, numeroDeCarga],
    );
    return resumen;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

interface Deposito {
  warehouseId: string;
  locationId: string;
}

async function crearDeposito(
  m: EntityManager,
  distributorId: string,
  d: {
    name: string;
    code: string;
    kind: 'depot' | 'branch';
    address: string;
    predeterminado: boolean;
  },
): Promise<Deposito> {
  const [w]: Array<{ warehouse_id: string }> = await m.query(
    `INSERT INTO "warehouse" ("distributor_id", "name", "code", "kind", "address", "is_default")
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING "warehouse_id"`,
    [distributorId, d.name, d.code, d.kind, d.address, d.predeterminado],
  );
  const [l]: Array<{ location_id: string }> = await m.query(
    `INSERT INTO "stock_location" ("distributor_id", "kind", "warehouse_id")
     VALUES ($1, 'warehouse', $2) RETURNING "location_id"`,
    [distributorId, w.warehouse_id],
  );
  return { warehouseId: w.warehouse_id, locationId: l.location_id };
}

function entrada(
  gasCylinderId: string,
  quantity: number,
  locationId: string,
  condition: StockCondition,
): MovimientoDeStock {
  return {
    gasCylinderId,
    quantity,
    from: null,
    to: { locationId, condition },
    reason: StockMovementReason.INITIAL_COUNT,
  };
}

function transferencia(
  gasCylinderId: string,
  quantity: number,
  origen: Deposito,
  destino: Deposito,
  condition: StockCondition,
): MovimientoDeStock {
  return {
    gasCylinderId,
    quantity,
    from: { locationId: origen.locationId, condition },
    to: { locationId: destino.locationId, condition },
    reason: StockMovementReason.TRANSFER,
  };
}

/** Descuenta del `lugar` las llenas de un pedido entregado y entra una vacía por cada una. */
async function entregar(
  m: EntityManager,
  ledger: StockLedgerService,
  ctx: ContextoDeStock,
  pedido: PedidoParaStock,
  lugar: string,
): Promise<void> {
  const porGarrafa = new Map<string, number>();
  for (const i of pedido.items) {
    porGarrafa.set(
      i.gasCylinderId,
      (porGarrafa.get(i.gasCylinderId) ?? 0) + i.quantity,
    );
  }
  const movimientos: MovimientoDeStock[] = [];
  for (const [gasCylinderId, quantity] of [...porGarrafa].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    movimientos.push(
      {
        gasCylinderId,
        quantity,
        from: { locationId: lugar, condition: StockCondition.FULL },
        to: null,
        reason: StockMovementReason.DELIVERY,
      },
      {
        gasCylinderId,
        quantity,
        from: null,
        to: { locationId: lugar, condition: StockCondition.EMPTY },
        reason: StockMovementReason.EMPTY_COLLECTED,
      },
    );
  }
  await ledger.aplicar(m, {
    distributorId: ctx.distributorId,
    referenceType: StockReferenceType.ORDER,
    referenceId: pedido.id,
    actorUserId: null,
    vendible: 'sin-cambio',
    occurredAt: pedido.entregadoEl ?? undefined,
    notes: 'Entrega de pedido',
    movimientos,
  });
}

// ─── Cargas de camión ────────────────────────────────────────────────────────

interface PlanDeCarga {
  chofer: ChoferParaStock;
  pedidos: PedidoParaStock[];
  /** Cuántas llenas de más salen en el camión (vuelven al rendir). */
  sobrante: Map<string, number>;
  conDiferencia: boolean;
  /** Garrafa de la que faltan 2 llenas al rendir (sólo si cierra con diferencia). */
  mermaDe: string | null;
}

/**
 * Elige tres (chofer, día) con varias entregas: una de la última semana, una de
 * hace unas dos semanas y una de hace un mes; la del medio cierra con diferencia.
 */
function planearCargas(ctx: ContextoDeStock): PlanDeCarga[] {
  const hoy = diaArgentino();
  const grupos = new Map<string, PedidoParaStock[]>();
  for (const p of ctx.pedidos) {
    if (p.estado !== 'delivered' || !p.entregadoEl || !p.deliveryId || !p.carId)
      continue;
    const dia = diaArgentino(p.entregadoEl);
    if (dia === hoy) continue;
    const clave = `${p.deliveryId}|${dia}`;
    grupos.set(clave, [...(grupos.get(clave) ?? []), p]);
  }
  const ahora = Date.now();
  const edadEnDias = (g: PedidoParaStock[]) =>
    (ahora - g[0].entregadoEl!.getTime()) / DIA_MS;
  const candidatos = [...grupos.values()].filter((g) => g.length >= 3);
  const elegir = (desde: number, hasta: number) =>
    candidatos
      .filter((g) => edadEnDias(g) >= desde && edadEnDias(g) < hasta)
      .sort((a, b) => b.length - a.length)[0];
  const elegidos = [elegir(1.2, 8), elegir(9, 20), elegir(21, 45)].filter(
    (g): g is PedidoParaStock[] => g !== undefined,
  );
  // Del más viejo al más nuevo: el número de carga sigue el orden del tiempo.
  elegidos.sort(
    (a, b) => a[0].entregadoEl!.getTime() - b[0].entregadoEl!.getTime(),
  );
  const cargas: PlanDeCarga[] = [];
  elegidos.forEach((g, i) => {
    const chofer = ctx.choferes.find((c) => c.deliveryId === g[0].deliveryId);
    if (!chofer) return;
    const entregado = new Map<string, number>();
    for (const p of g) {
      for (const it of p.items) {
        entregado.set(
          it.gasCylinderId,
          (entregado.get(it.gasCylinderId) ?? 0) + it.quantity,
        );
      }
    }
    // Sobrante: el camión siempre sale con algunas de más.
    const sobrante = new Map<string, number>();
    [...entregado.keys()].forEach((id, k) => sobrante.set(id, 2 + (k % 3)));
    const conDiferencia =
      elegidos.length >= 2 && i === Math.floor(elegidos.length / 2);
    cargas.push({
      chofer,
      pedidos: g,
      sobrante,
      conDiferencia,
      mermaDe: conDiferencia ? ([...entregado.keys()][0] ?? null) : null,
    });
  });
  return cargas;
}

async function ubicacionDeCamion(
  m: EntityManager,
  distributorId: string,
  carId: string,
): Promise<string> {
  await m.query(
    `INSERT INTO "stock_location" ("distributor_id", "kind", "car_id")
     VALUES ($1, 'vehicle', $2) ON CONFLICT ("car_id") DO NOTHING`,
    [distributorId, carId],
  );
  const [l]: Array<{ location_id: string }> = await m.query(
    `SELECT "location_id" FROM "stock_location" WHERE "car_id" = $1`,
    [carId],
  );
  return l.location_id;
}

async function sembrarCargaRendida(
  m: EntityManager,
  ledger: StockLedgerService,
  ctx: ContextoDeStock,
  deposito: string,
  plan: PlanDeCarga,
  extra: { numero: number; resumen: ResumenDeStock },
): Promise<void> {
  const { distributorId, adminUserId } = ctx;
  const camion = await ubicacionDeCamion(m, distributorId, plan.chofer.carId);
  const entregas = plan.pedidos
    .map((p) => p.entregadoEl!.getTime())
    .sort((a, b) => a - b);
  const salioEl = new Date(entregas[0] - 100 * 60 * 1000);
  const volvioEl = new Date(entregas[entregas.length - 1] + 70 * 60 * 1000);

  const entregado = new Map<string, number>();
  for (const p of plan.pedidos) {
    for (const it of p.items) {
      entregado.set(
        it.gasCylinderId,
        (entregado.get(it.gasCylinderId) ?? 0) + it.quantity,
      );
    }
  }
  const [carga]: Array<{ load_id: string }> = await m.query(
    `INSERT INTO "truck_load"
       ("distributor_id", "number", "car_id", "delivery_id", "helper_employee_id", "origin_location_id", "business_date",
        "status", "opened_at", "departed_at", "returned_at", "closed_at", "opened_by_user_id", "closed_by_user_id",
        "difference_note", "notes")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $10, $11, $11, $12, $13)
     RETURNING "load_id"`,
    [
      distributorId,
      extra.numero,
      plan.chofer.carId,
      plan.chofer.deliveryId,
      plan.chofer.ayudanteId,
      deposito,
      diaArgentino(salioEl),
      plan.conDiferencia ? 'closed_with_difference' : 'closed',
      salioEl,
      volvioEl,
      adminUserId,
      plan.conDiferencia
        ? 'Se rompieron 2 garrafas al bajarlas en una calle de tierra'
        : null,
      `Reparto del ${diaArgentino(salioEl)}`,
    ],
  );
  const base = {
    distributorId,
    referenceType: StockReferenceType.TRUCK_LOAD,
    referenceId: carga.load_id,
    actorUserId: adminUserId,
  };
  await ledger.aplicar(m, {
    ...base,
    occurredAt: salioEl,
    notes: `Salida del camión (carga N° ${extra.numero})`,
    movimientos: [...entregado].map(([gasCylinderId, quantity]) => ({
      gasCylinderId,
      quantity: quantity + (plan.sobrante.get(gasCylinderId) ?? 0),
      from: { locationId: deposito, condition: StockCondition.FULL },
      to: { locationId: camion, condition: StockCondition.FULL },
      reason: StockMovementReason.TRUCK_LOAD,
    })),
  });
  for (const p of plan.pedidos.sort(
    (a, b) => a.entregadoEl!.getTime() - b.entregadoEl!.getTime(),
  )) {
    await entregar(m, ledger, ctx, p, camion);
    extra.resumen.entregasEnLibro += 1;
  }

  // Rendición: vuelven las sobrantes y todas las vacías; en la que cierra con
  // diferencia faltan 2 llenas del primer producto.
  const renglones = [...entregado].map(([gasCylinderId, cantidad]) => {
    const sobra = plan.sobrante.get(gasCylinderId) ?? 0;
    const falta = plan.mermaDe === gasCylinderId ? 2 : 0;
    return { gasCylinderId, cantidad, sobra, falta };
  });
  const cierre = planDeCierre(
    camion,
    deposito,
    renglones.map((r) => ({
      gasCylinderId: r.gasCylinderId,
      ...esperadoDe({
        loadedFull: r.cantidad + r.sobra,
        reloadedFull: 0,
        deliveredFull: r.cantidad,
        loadedEmpty: 0,
        collectedEmpty: r.cantidad,
      }),
      declaredFull: r.sobra - r.falta,
      declaredEmpty: r.cantidad,
      balanceFull: r.sobra,
      balanceEmpty: r.cantidad,
    })),
  );
  await ledger.aplicar(m, {
    ...base,
    occurredAt: volvioEl,
    notes: `Rendición del camión (carga N° ${extra.numero})`,
    movimientos: cierre.movimientos,
  });
  for (const r of cierre.renglones) {
    const fila = renglones.find((x) => x.gasCylinderId === r.gasCylinderId)!;
    await m.query(
      `INSERT INTO "truck_load_item"
         ("load_id", "gas_cylinder_id", "loaded_full", "reloaded_full", "loaded_empty", "declared_return_full",
          "declared_return_empty", "delivered_full", "collected_empty", "expected_full", "expected_empty",
          "difference_full", "difference_empty")
       VALUES ($1, $2, $3, 0, 0, $4, $5, $6, $6, $7, $8, $9, $10)`,
      [
        carga.load_id,
        r.gasCylinderId,
        fila.cantidad + fila.sobra,
        fila.sobra - fila.falta,
        fila.cantidad,
        fila.cantidad,
        fila.sobra,
        fila.cantidad,
        r.differenceFull,
        r.differenceEmpty,
      ],
    );
  }
  extra.resumen.cargasDeCamion += 1;
  extra.resumen.documentos.push({
    entidad: 'TruckLoad',
    id: carga.load_id,
    cuando: salioEl,
    detalle: {
      number: String(extra.numero),
      status: plan.conDiferencia ? 'closed_with_difference' : 'closed',
    },
  });
}

/**
 * La carga de hoy: el primer chofer sale con las garrafas de sus pedidos
 * aceptados y en camino. Queda abierta (`on_route`). Devuelve false si no hay.
 */
async function sembrarCargaAbierta(
  m: EntityManager,
  ledger: StockLedgerService,
  ctx: ContextoDeStock,
  deposito: string,
  numero: number,
): Promise<boolean> {
  const { distributorId, adminUserId } = ctx;
  for (const chofer of ctx.choferes) {
    const abiertos = ctx.pedidos.filter(
      (p) =>
        p.deliveryId === chofer.deliveryId &&
        (p.estado === 'accepted' || p.estado === 'on_the_way'),
    );
    if (abiertos.length === 0) continue;
    const cantidades = new Map<string, number>();
    for (const p of abiertos) {
      for (const it of p.items) {
        cantidades.set(
          it.gasCylinderId,
          (cantidades.get(it.gasCylinderId) ?? 0) + it.quantity,
        );
      }
    }
    const camion = await ubicacionDeCamion(m, distributorId, chofer.carId);
    const salioEl = hace(0, 2);
    const [carga]: Array<{ load_id: string }> = await m.query(
      `INSERT INTO "truck_load"
         ("distributor_id", "number", "car_id", "delivery_id", "helper_employee_id", "origin_location_id", "business_date",
          "status", "opened_at", "departed_at", "opened_by_user_id", "notes")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'on_route', $8, $8, $9, 'Reparto de hoy')
       RETURNING "load_id"`,
      [
        distributorId,
        numero,
        chofer.carId,
        chofer.deliveryId,
        chofer.ayudanteId,
        deposito,
        diaArgentino(salioEl),
        salioEl,
        adminUserId,
      ],
    );
    await ledger.aplicar(m, {
      distributorId,
      referenceType: StockReferenceType.TRUCK_LOAD,
      referenceId: carga.load_id,
      actorUserId: adminUserId,
      occurredAt: salioEl,
      notes: `Salida del camión (carga N° ${numero})`,
      movimientos: [...cantidades].map(([gasCylinderId, quantity]) => ({
        gasCylinderId,
        quantity,
        from: { locationId: deposito, condition: StockCondition.FULL },
        to: { locationId: camion, condition: StockCondition.FULL },
        reason: StockMovementReason.TRUCK_LOAD,
      })),
    });
    for (const [gasCylinderId, quantity] of cantidades) {
      await m.query(
        `INSERT INTO "truck_load_item" ("load_id", "gas_cylinder_id", "loaded_full", "reloaded_full", "loaded_empty",
            "delivered_full", "collected_empty")
         VALUES ($1, $2, $3, 0, 0, 0, 0)`,
        [carga.load_id, gasCylinderId, quantity],
      );
    }
    return true;
  }
  return false;
}

// ─── Compras ─────────────────────────────────────────────────────────────────

interface Proveedor {
  id: string;
}

async function crearProveedor(
  m: EntityManager,
  distributorId: string,
  p: {
    nombre: string;
    cuit: string;
    tipo: 'filling_plant' | 'other';
    contacto: string;
    telefono: string;
    email: string;
    direccion: string;
    plazo: number;
  },
): Promise<Proveedor> {
  const [fila]: Array<{ supplier_id: string }> = await m.query(
    `INSERT INTO "supplier"
       ("distributor_id", "business_name", "cuit", "kind", "contact_name", "phone", "email", "address", "payment_terms_days")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING "supplier_id"`,
    [
      distributorId,
      p.nombre,
      p.cuit,
      p.tipo,
      p.contacto,
      p.telefono,
      p.email,
      p.direccion,
      p.plazo,
    ],
  );
  return { id: fila.supplier_id };
}

interface RenglonDeOrden {
  peso: number;
  pedido: number;
  recibido: number;
}

interface OrdenPlaneada {
  numero: number;
  proveedor: Proveedor;
  estado:
    | 'draft'
    | 'sent'
    | 'partially_received'
    | 'received'
    | 'closed_short'
    | 'cancelled';
  emitidaHaceDias: number;
  recibidaHaceDias: number | null;
  renglones: RenglonDeOrden[];
  remito?: {
    tipo: 'delivery_note' | 'invoice';
    numero: string;
    pagada: boolean;
  };
  notas: string;
  cierre?: string;
  cancelacion?: string;
}

async function sembrarCompras(
  m: EntityManager,
  ledger: StockLedgerService,
  ctx: ContextoDeStock,
  central: Deposito,
  resumen: ResumenDeStock,
): Promise<void> {
  const { distributorId, adminUserId } = ctx;
  const litoral = await crearProveedor(m, distributorId, {
    nombre: 'Gas del Litoral S.A.',
    cuit: cuitDe('30', '71234567'),
    tipo: 'filling_plant',
    contacto: 'Marta Gómez',
    telefono: '+543764123456',
    email: 'compras@gasdellitoral.com.ar',
    direccion: 'Ruta Nacional 14 km 1030, Garupá, Misiones',
    plazo: 30,
  });
  const misionera = await crearProveedor(m, distributorId, {
    nombre: 'Fraccionadora Misionera S.R.L.',
    cuit: cuitDe('30', '70998877'),
    tipo: 'filling_plant',
    contacto: 'Julio Sánchez',
    telefono: '+543764765432',
    email: 'ventas@fraccionadoramisionera.com.ar',
    direccion: 'Parque Industrial Posadas, Lote 14, Misiones',
    plazo: 15,
  });
  await crearProveedor(m, distributorId, {
    nombre: 'Válvulas y Reguladores Posadas S.R.L.',
    cuit: cuitDe('30', '71556677'),
    tipo: 'other',
    contacto: 'Raúl Benítez',
    telefono: '+543764334455',
    email: 'info@valvulasposadas.com.ar',
    direccion: 'Av. Mitre 1840, Posadas, Misiones',
    plazo: 0,
  });
  await crearProveedor(m, distributorId, {
    nombre: 'Transportes Alto Paraná S.A.',
    cuit: cuitDe('30', '70112233'),
    tipo: 'other',
    contacto: 'Silvia Duarte',
    telefono: '+543764556677',
    email: 'logistica@altoparana.com.ar',
    direccion: 'Av. Santa Catalina 4200, Posadas, Misiones',
    plazo: 7,
  });
  resumen.proveedores = 4;

  const ordenes: OrdenPlaneada[] = PLAN_DE_COMPRAS.map((o) => ({
    ...o,
    proveedor: o.proveedor === 'litoral' ? litoral : misionera,
  }));

  let numeroDeRemito = 0;
  for (const o of ordenes) {
    const renglones = o.renglones.flatMap((r) => {
      const p = ctx.productos.find((x) => x.weight === r.peso);
      return p ? [{ ...r, producto: p }] : [];
    });
    const costos = renglones.map((r) => ({
      gasCylinderId: r.producto.id,
      quantity: r.pedido,
      // La distribuidora compra a ~65 % del precio de lista.
      unitCost:
        Math.round(r.producto.price * (0.63 + (o.numero % 3) * 0.015) * 100) /
        100,
    }));
    const emitida = hace(o.emitidaHaceDias);
    const [orden]: Array<{ purchase_order_id: string }> = await m.query(
      `INSERT INTO "purchase_order"
         ("distributor_id", "number", "supplier_id", "destination_warehouse_id", "status", "issued_at", "expected_date",
          "total_amount", "cancel_reason", "close_reason", "notes", "created_by_user_id", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $6)
       RETURNING "purchase_order_id"`,
      [
        distributorId,
        o.numero,
        o.proveedor.id,
        central.warehouseId,
        o.estado,
        emitida,
        o.estado === 'sent' ? diaArgentino(hace(-2)) : null,
        totalDe(costos),
        o.cancelacion ?? null,
        o.cierre ?? null,
        o.notas,
        adminUserId,
      ],
    );
    resumen.ordenesDeCompra += 1;
    resumen.documentos.push({
      entidad: 'PurchaseOrder',
      id: orden.purchase_order_id,
      cuando: emitida,
      detalle: { number: String(o.numero), status: o.estado },
    });

    const itemsIds: string[] = [];
    // Vacías que se canjean: las que haya en el depósito (no más que lo recibido).
    const canje = new Map<string, number>();
    for (const [i, r] of renglones.entries()) {
      const [{ vacias }]: Array<{ vacias: number }> = await m.query(
        `SELECT COALESCE(SUM("quantity"), 0)::int AS vacias FROM "stock_balance"
          WHERE "location_id" = $1 AND "gas_cylinder_id" = $2 AND "condition" = 'empty'`,
        [central.locationId, r.producto.id],
      );
      const cuantas = Math.min(r.recibido, vacias);
      canje.set(r.producto.id, cuantas);
      const [item]: Array<{ item_id: string }> = await m.query(
        `INSERT INTO "purchase_order_item"
           ("purchase_order_id", "gas_cylinder_id", "quantity", "unit_cost", "empties_to_exchange", "received_quantity")
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING "item_id"`,
        [
          orden.purchase_order_id,
          r.producto.id,
          r.pedido,
          costos[i].unitCost,
          Math.min(r.pedido, Math.max(cuantas, Math.round(r.pedido * 0.8))),
          r.recibido,
        ],
      );
      itemsIds.push(item.item_id);
    }

    if (!o.remito || o.recibidaHaceDias === null) continue;
    numeroDeRemito += 1;
    const recibida = hace(o.recibidaHaceDias, 2);
    const recibidos = renglones
      .map((r, i) => ({ ...r, costo: costos[i].unitCost }))
      .filter((r) => r.recibido > 0);
    const total = totalDe(
      recibidos.map((r) => ({
        gasCylinderId: r.producto.id,
        quantity: r.recibido,
        unitCost: r.costo,
      })),
    );
    const [remito]: Array<{ receipt_id: string }> = await m.query(
      `INSERT INTO "purchase_receipt"
         ("distributor_id", "number", "supplier_id", "purchase_order_id", "warehouse_id", "supplier_document_type",
          "supplier_document_number", "received_at", "received_by_user_id", "total_amount", "payment_status", "batch_id",
          "notes", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, gen_random_uuid(), $12, $8)
       RETURNING "receipt_id"`,
      [
        distributorId,
        numeroDeRemito,
        o.proveedor.id,
        orden.purchase_order_id,
        central.warehouseId,
        o.remito.tipo,
        o.remito.numero,
        recibida,
        adminUserId,
        total,
        o.remito.pagada ? 'paid' : 'unpaid',
        o.estado === 'closed_short'
          ? 'Faltaron 20 garrafas de 10 kg'
          : o.estado === 'partially_received'
            ? 'Primera entrega'
            : null,
      ],
    );
    const { batchId } = await ledger.aplicar(m, {
      distributorId,
      referenceType: StockReferenceType.PURCHASE_RECEIPT,
      referenceId: remito.receipt_id,
      actorUserId: adminUserId,
      occurredAt: recibida,
      movimientos: recibidos.flatMap((r) => {
        const salen = Math.min(canje.get(r.producto.id) ?? 0, r.recibido);
        const movimientos: MovimientoDeStock[] = [
          {
            gasCylinderId: r.producto.id,
            quantity: r.recibido,
            from: null,
            to: {
              locationId: central.locationId,
              condition: StockCondition.FULL,
            },
            reason: StockMovementReason.PURCHASE_RECEIPT,
          },
        ];
        if (salen > 0) {
          movimientos.push({
            gasCylinderId: r.producto.id,
            quantity: salen,
            from: {
              locationId: central.locationId,
              condition: StockCondition.EMPTY,
            },
            to: null,
            reason: StockMovementReason.PLANT_EMPTY_OUT,
          });
        }
        return movimientos;
      }),
    });
    await m.query(
      `UPDATE "purchase_receipt" SET "batch_id" = $2 WHERE "receipt_id" = $1`,
      [remito.receipt_id, batchId],
    );
    for (const r of recibidos) {
      const [{ previa, costoPrevio }]: Array<{
        previa: number;
        costoPrevio: string | null;
      }> = await m.query(
        `SELECT (COALESCE((SELECT SUM("quantity") FROM "stock_balance"
                            WHERE "distributor_id" = $1 AND "gas_cylinder_id" = $2 AND "condition" = 'full'), 0) - $3)::int AS previa,
                (SELECT "average_unit_cost" FROM "gas_cylinder" WHERE "gas_cylinder_id" = $2) AS "costoPrevio"`,
        [distributorId, r.producto.id, r.recibido],
      );
      const salen = Math.min(canje.get(r.producto.id) ?? 0, r.recibido);
      await m.query(
        `INSERT INTO "purchase_receipt_item"
           ("receipt_id", "gas_cylinder_id", "quantity_full", "quantity_empty_out", "unit_cost", "previous_average_cost",
            "previous_on_hand", "previous_on_hand_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          remito.receipt_id,
          r.producto.id,
          r.recibido,
          salen,
          r.costo,
          costoPrevio,
          previa,
          recibida,
        ],
      );
      await m.query(
        `UPDATE "gas_cylinder" SET "average_unit_cost" = $2 WHERE "gas_cylinder_id" = $1`,
        [
          r.producto.id,
          costoPromedioPonderado({
            existenciaPrevia: previa,
            costoPrevio: costoPrevio === null ? null : Number(costoPrevio),
            cantidad: r.recibido,
            costoNuevo: r.costo,
          }),
        ],
      );
    }
    resumen.recepciones += 1;
    resumen.recepcionesIds.push({
      receiptId: remito.receipt_id,
      numero: o.remito.numero,
    });
    resumen.documentos.push({
      entidad: 'PurchaseReceipt',
      id: remito.receipt_id,
      cuando: recibida,
      detalle: {
        number: String(numeroDeRemito),
        supplierDocumentNumber: o.remito.numero,
      },
    });
  }

  await m.query(
    `INSERT INTO "document_sequence" ("distributor_id", "doc_type", "last_number") VALUES
       ($1, 'purchase_order', $2), ($1, 'purchase_receipt', $3)
     ON CONFLICT ("distributor_id", "doc_type") DO UPDATE SET "last_number" = EXCLUDED."last_number"`,
    [distributorId, ordenes.length, numeroDeRemito],
  );
}
